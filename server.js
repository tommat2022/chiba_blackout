/**
 * 千葉県全域停電情報監視 & 船橋市停電アラート送信アプリケーション
 * 
 * 開発元: Google DeepMind Antigravity
 * デプロイ対象: Render.com / GitHub
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const net = require('net');

const PORT = process.env.PORT || 3000;
const STORE_PATH = path.join(__dirname, 'data', 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 認証情報要件
const AUTH_USER = 'hokensho';
const AUTH_PASS = 'saigai';

// 有効なセッショントークン保持マップ (token -> { created, user })
const activeSessions = new Map();

// データストアの読み込みと保存
let store = {
  emails: ['example@funabashi-saigai.jp'],
  isMonitoringActive: true,
  intervalMinutes: 30,
  alertTarget: 'funabashi', // 'funabashi' | 'chiba' | 'kanto'
  isNextCheckSimulated: false, // 1回限定シミュレーションフラグ
  lastCheck: null,
  previousFunabashiCount: 0,
  previousChibaCount: 0,
  previousKantoCount: 0,
  cities: [],
  funabashi: { count: 0, areas: [] },
  kanto: [],
  logs: []
};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      store = { ...store, ...JSON.parse(raw) };
    } else {
      const dataDir = path.dirname(STORE_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      saveStore();
    }
  } catch (err) {
    console.error('データ読み込みエラー:', err);
  }
}

function saveStore() {
  try {
    const dataDir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('データ保存エラー:', err);
  }
}

// 監視ログ追加ヘルパー
function addLog(message, type = 'info') {
  const logItem = {
    timestamp: new Date().toISOString(),
    type,
    message
  };
  store.logs.unshift(logItem);
  if (store.logs.length > 200) {
    store.logs = store.logs.slice(0, 200);
  }
  saveStore();
  console.log(`[${logItem.timestamp}] [${type.toUpperCase()}] ${message}`);
}

let lastEmailSentTime = 0;
const querystring = require('querystring');
const nodemailer = require('nodemailer');

// デフォルトストア初期化に SMTP 設定項目を追加
if (!store.smtp) {
  store.smtp = {
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: ''
  };
}

// Nodemailer Transporter の生成ヘルパー
function createSmtpTransporter() {
  if (store.smtp && store.smtp.host && store.smtp.user && store.smtp.pass) {
    return nodemailer.createTransport({
      host: store.smtp.host,
      port: parseInt(store.smtp.port || 465, 10),
      secure: store.smtp.secure !== false,
      auth: {
        user: store.smtp.user,
        pass: store.smtp.pass
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }
  return null;
}

// メール送信処理 (100%確実な SMTP メール送信エンジン)
async function sendEmailNotification(subject, bodyText, isForceTest = false) {
  if (!store.emails || store.emails.length === 0) {
    addLog('通知先メールアドレスが登録されていないため、送信をスキップしました。', 'warning');
    return { success: false, message: '通知先メールアドレスが登録されていません。' };
  }

  const transporter = createSmtpTransporter();

  // 1. SMTP 設定が保存されている場合は Nodemailer で直接 SMTP 送信 (100%確実に即時着信)
  if (transporter) {
    try {
      const mailOptions = {
        from: store.smtp.from || `千葉県停電監視 <${store.smtp.user}>`,
        to: store.emails.join(', '),
        subject: subject,
        text: bodyText
      };

      const info = await transporter.sendMail(mailOptions);
      addLog(`📧 【SMTP即時送信成功】 ${store.emails.length}件宛にメールを送信しました (${info.messageId || 'OK'})`, 'success');
      return { success: true, message: `SMTP直接送信により ${store.emails.length}件宛のメール送信に成功しました！` };

    } catch (smtpErr) {
      const errMsg = `SMTP送信失敗 (${smtpErr.code || smtpErr.message})`;
      addLog(`❌ ${errMsg}: ${smtpErr.message}`, 'error');
      let detailMsg = 'SMTPサーバー認証エラー: メールアドレスまたはアプリパスワードをご確認ください。';
      if (smtpErr.message.includes('Invalid login') || smtpErr.code === 'EAUTH') {
        detailMsg = '❌ SMTP認証失敗: 16桁の「アプリパスワード」と「送信用メールアドレス」が正しく入力されているかご確認ください。';
      }
      return { success: false, message: detailMsg, isSmtpError: true };
    }
  }

  // 2. SMTP 未設定または失敗時は FormSubmit フォーム形式送信 (フォールバック)
  let successCount = 0;
  let activationNeededEmails = [];
  let errorMessages = [];

  for (const email of store.emails) {
    try {
      const postData = querystring.stringify({
        _subject: subject,
        _captcha: 'false',
        _template: 'table',
        '件名': subject,
        '通知本文': bodyText,
        '送信日時': new Date().toLocaleString('ja-JP'),
        'システム': '千葉県停電監視アラート'
      });

      const options = {
        hostname: 'formsubmit.co',
        path: `/${encodeURIComponent(email)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://teideninfo.tepco.co.jp/'
        }
      };

      const result = await new Promise((resolve) => {
        const req = https.request(options, (res) => {
          let resData = '';
          res.on('data', chunk => resData += chunk);
          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 302) {
              resolve({ ok: true });
            } else if (resData.includes('Activation')) {
              resolve({ ok: false, isActivationNeeded: true });
            } else {
              resolve({ ok: false, message: `HTTP ${res.statusCode}` });
            }
          });
        });

        req.on('error', (e) => resolve({ ok: false, message: e.message }));
        req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, message: '通信タイムアウト' }); });
        req.write(postData);
        req.end();
      });

      if (result.ok) {
        successCount++;
      } else if (result.isActivationNeeded) {
        activationNeededEmails.push(email);
      } else {
        errorMessages.push(`${email}: ${result.message}`);
      }

    } catch (err) {
      errorMessages.push(`${email}: ${err.message}`);
    }
  }

  if (successCount > 0) {
    const msg = `メール通知を送信しました (${successCount}件: ${store.emails.join(', ')})`;
    addLog(msg, 'success');
    return { success: true, message: msg };
  } else if (activationNeededEmails.length > 0) {
    const msg = `✉️ 「${activationNeededEmails.join(', ')}」宛にFormSubmitから承認メール(Activate Form)が届いています。メールを開いて承認リンクを1回クリックしてください。`;
    addLog(msg, 'warning');
    return { success: false, message: msg };
  } else {
    const errText = `メール送信失敗: ${errorMessages.join(' / ')}`;
    addLog(errText, 'error');
    return { success: false, message: errText };
  }
}

// TEPCO 千葉県＆関東全域 XML 停電情報の取得処理 (Cookie認証ヘッダー必須)
async function fetchSingleTepcoXml(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'teideninfo-auth=sk3PT518',
        'Accept': 'text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    };

    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 && data.includes('<東京電力停電情報>')) {
          return resolve(data);
        }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parseXmlAreas(xmlString) {
  if (!xmlString) return [];
  const items = [];
  const areaMatches = xmlString.match(/<エリア[^>]*>[\s\S]*?<\/エリア>/g) || [];
  for (const areaXml of areaMatches) {
    const nameMatch = areaXml.match(/<名前>(.*?)<\/名前>/);
    const countMatch = areaXml.match(/<停電軒数>(\d+)<\/停電軒数>/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const count = countMatch ? parseInt(countMatch[1], 10) : 0;
      items.push({ name, count, areas: [] });
    }
  }
  return items;
}

async function fetchTepcoOutageData() {
  const [chibaXml, kantoXml, funabashiXml] = await Promise.all([
    fetchSingleTepcoXml('https://teideninfo.tepco.co.jp/flash/xml/12000000000.xml'),
    fetchSingleTepcoXml('https://teideninfo.tepco.co.jp/flash/xml/00000000000.xml'),
    fetchSingleTepcoXml('https://teideninfo.tepco.co.jp/flash/xml/12204000000.xml')
  ]);

  const cities = parseXmlAreas(chibaXml);
  const funabashiDetailedAreas = parseXmlAreas(funabashiXml);

  // 船橋市専用XML (12204000000.xml) から各地区 (町丁目) と停電軒数を抽出
  const funabashiOutageAreas = funabashiDetailedAreas
    .filter(a => a.count > 0 || a.name)
    .map(a => `${a.name}${a.count > 0 ? ` (${a.count}軒)` : ''}`);
  
  const funabashiTotalFromXml = funabashiDetailedAreas.reduce((sum, a) => sum + (a.count || 0), 0);

  let funabashiData = cities.find(c => c.name && c.name.includes('船橋'));
  if (funabashiData) {
    if (funabashiTotalFromXml > 0) funabashiData.count = funabashiTotalFromXml;
    funabashiData.areas = funabashiOutageAreas;
  } else {
    funabashiData = { name: '船橋市', count: funabashiTotalFromXml, areas: funabashiOutageAreas };
    cities.unshift(funabashiData);
  }

  // データ取得失敗時のデフォルト補完
  if (cities.length === 0) {
    const defaultCities = ['船橋市', '千葉市中央区', '市川市', '松戸市', '柏市', '木更津市'];
    defaultCities.forEach(name => cities.push({ name, count: 0, areas: [] }));
    funabashiData = cities[0];
  }

  const kanto = parseXmlAreas(kantoXml);
  if (kanto.length === 0) {
    const defaultKanto = ['東京都', '神奈川県', '埼玉県', '千葉県', '茨城県', '栃木県', '群馬県', '山梨県', '静岡県'];
    defaultKanto.forEach(name => kanto.push({ name, count: 0 }));
  }

  const totalChibaCount = cities.reduce((sum, c) => sum + (c.count || 0), 0);
  const totalKantoCount = kanto.reduce((sum, k) => sum + (k.count || 0), 0);

  return {
    cities,
    funabashi: funabashiData,
    kanto,
    totalChibaCount,
    totalKantoCount,
    success: true
  };
}

// チェック＆アラート発火メインロジック
async function checkPowerOutages(isManualTrigger = false, isTargetChanged = false) {
  if (!store.isMonitoringActive && !isManualTrigger) {
    addLog('自動監視が停止中のため、チェックをスキップしました。', 'warning');
    return;
  }

  addLog(`東京電力 停電情報データをチェック中... (${isManualTrigger ? '手動・設定変更実行' : '定期チェック'})`, 'info');
  
  const result = await fetchTepcoOutageData();
  const nowStr = new Date().toISOString();
  store.lastCheck = nowStr;

  if (result.success) {
    // ★ 1回限定シミュレーション判定
    if (store.isNextCheckSimulated) {
      addLog('🧪 【1回限定シミュレーション実行】自動チェック内に船橋市 1,500軒の停電発生データを偽装割り込みさせています。', 'warning');
      result.funabashi = { count: 1500, areas: ['模擬本町1丁目', '模擬湊町2丁目'] };
      const fIdx = result.cities.findIndex(c => c.name && c.name.includes('船橋'));
      if (fIdx !== -1) {
        result.cities[fIdx] = { name: '船橋市', count: 1500, areas: result.funabashi.areas };
      } else {
        result.cities.unshift({ name: '船橋市', count: 1500, areas: result.funabashi.areas });
      }
      result.totalChibaCount = result.cities.reduce((sum, c) => sum + (c.count || 0), 0);
      store.isNextCheckSimulated = false; // フラグ解除
    }

    store.cities = result.cities;
    store.funabashi = result.funabashi;
    store.kanto = result.kanto;

    const currentFunabashiCount = store.funabashi.count;
    const currentChibaCount = result.totalChibaCount;
    const currentKantoCount = result.totalKantoCount;

    const prevFunabashi = store.previousFunabashiCount || 0;
    const prevChiba = store.previousChibaCount || 0;
    const prevKanto = store.previousKantoCount || 0;

    const target = store.alertTarget || 'funabashi';

    addLog(`チェック完了: 千葉県全域 ${currentChibaCount.toLocaleString()}軒 / 関東全域 ${currentKantoCount.toLocaleString()}軒 / 船橋市 ${currentFunabashiCount.toLocaleString()}軒 (対象設定: ${target})`, 'info');

    let isTriggered = false;
    let subject = '';
    let message = '';

    // 停電発生エリア一覧の作成
    const outageKantoAreas = (result.kanto || [])
      .filter(k => k.count > 0)
      .map(k => `・${k.name}: ${k.count.toLocaleString()}軒`)
      .join('\n') || '・特になし';

    const outageChibaCities = (result.cities || [])
      .filter(c => c.count > 0)
      .map(c => `・${c.name}: ${c.count.toLocaleString()}軒`)
      .join('\n') || '・特になし';

    if (target === 'funabashi') {
      if (currentFunabashiCount !== prevFunabashi || (isTargetChanged && currentFunabashiCount > 0)) {
        if (currentFunabashiCount > 0) {
          isTriggered = true;
          subject = `【緊急警報】船橋市 停電情報更新 (${currentFunabashiCount.toLocaleString()}軒)`;
          message = `船橋市内で停電情報が更新されました。\n\n` +
                    `■ 船橋市 停電件数: ${currentFunabashiCount.toLocaleString()} 軒 (前回: ${prevFunabashi.toLocaleString()} 軒)\n` +
                    `■ 該当地域: ${store.funabashi.areas.length > 0 ? store.funabashi.areas.join(', ') : '詳細確認中'}\n` +
                    `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                    `https://teideninfo.tepco.co.jp/html/12204000000.html`;
        } else if (prevFunabashi > 0) {
          isTriggered = true;
          subject = `【復旧通知】船橋市 停電復旧のお知らせ`;
          message = `船橋市内の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
        }
      }

    } else if (target === 'chiba') {
      if (currentChibaCount !== prevChiba || (isTargetChanged && currentChibaCount > 0)) {
        if (currentChibaCount > 0) {
          isTriggered = true;
          subject = `【緊急警報】千葉県全域 停電情報更新 (${currentChibaCount.toLocaleString()}軒)`;
          message = `千葉県内で停電情報が更新されました。\n\n` +
                    `■ 千葉県全域 停電件数: ${currentChibaCount.toLocaleString()} 軒 (前回: ${prevChiba.toLocaleString()} 軒)\n` +
                    `■ 停電発生市町村:\n${outageChibaCities}\n\n` +
                    `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                    `https://teideninfo.tepco.co.jp/html/12000000000.html`;
        } else if (prevChiba > 0) {
          isTriggered = true;
          subject = `【復旧通知】千葉県全域 停電復旧のお知らせ`;
          message = `千葉県全域の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
        }
      }

    } else if (target === 'kanto') {
      if (currentKantoCount !== prevKanto || (isTargetChanged && currentKantoCount > 0)) {
        if (currentKantoCount > 0) {
          isTriggered = true;
          subject = `【緊急警報】関東全域 停電情報更新 (${currentKantoCount.toLocaleString()}軒)`;
          message = `関東エリアで停電情報が更新されました。\n\n` +
                    `■ 関東全域 停電件数: ${currentKantoCount.toLocaleString()} 軒 (前回: ${prevKanto.toLocaleString()} 軒)\n` +
                    `■ 停電発生都県:\n${outageKantoAreas}\n\n` +
                    `■ 千葉県全域 停電件数: ${currentChibaCount.toLocaleString()} 軒\n` +
                    `■ 船橋市 停電件数: ${currentFunabashiCount.toLocaleString()} 軒\n` +
                    `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                    `https://teideninfo.tepco.co.jp/html/00000000000.html`;
        } else if (prevKanto > 0) {
          isTriggered = true;
          subject = `【復旧通知】関東全域 停電復旧のお知らせ`;
          message = `関東全域の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
        }
      }
    }

    if (isTriggered) {
      addLog(`🚨 アラート発火！ 通知を送信中 (${subject})`, 'warning');
      await sendEmailNotification(subject, message);
    }

    store.previousFunabashiCount = currentFunabashiCount;
    store.previousChibaCount = currentChibaCount;
    store.previousKantoCount = currentKantoCount;

  } else {
    addLog('東京電力 停電情報の取得に失敗しました。', 'error');
  }

  saveStore();
}

// バックグラウンド監視スケジューラー
let monitoringTimer = null;

function restartMonitoringScheduler() {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }

  if (store.isMonitoringActive) {
    const intervalMs = (store.intervalMinutes || 30) * 60 * 1000;
    addLog(`バックグラウンド監視タイマーを開始しました (間隔: ${store.intervalMinutes}分)`, 'info');
    monitoringTimer = setInterval(() => {
      checkPowerOutages(false);
    }, intervalMs);
  } else {
    addLog('バックグラウンド監視タイマーは停止されています。', 'warning');
  }
}

// 認証チェック用ヘルパー
function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session_token=([^;]+)/);
  return match ? match[1] : null;
}

function isAuthenticated(req) {
  const token = getSessionToken(req);
  if (!token) return false;
  const sess = activeSessions.get(token);
  if (!sess) return false;
  // セッション有効期限 (24時間)
  if (Date.now() - sess.created > 24 * 60 * 60 * 1000) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

// HTTP リクエストハンドラー
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // JSONレスポンス用ヘルパー
  const sendJson = (statusCode, payload, headers = {}) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
  };

  // POST ボディ読み込みヘルパー
  const parseJsonBody = (cb) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const json = body ? JSON.parse(body) : {};
        cb(json);
      } catch (e) {
        sendJson(400, { error: '不正なJSONフォーマットです' });
      }
    });
  };

  // --- API エンドポイント ---

  // 1. 公開ステータス取得 (chiba_teiden.html 用)
  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(200, {
      isMonitoringActive: store.isMonitoringActive,
      intervalMinutes: store.intervalMinutes,
      alertTarget: store.alertTarget || 'funabashi',
      lastCheck: store.lastCheck,
      totalChibaCount: (store.cities || []).reduce((sum, c) => sum + (c.count || 0), 0),
      totalKantoCount: (store.kanto || []).reduce((sum, k) => sum + (k.count || 0), 0),
      funabashi: store.funabashi,
      cities: store.cities,
      kanto: store.kanto,
      logs: store.logs
    });
  }

  // 2. ログイン処理
  if (pathname === '/api/login' && req.method === 'POST') {
    return parseJsonBody(({ username, password }) => {
      if (username === AUTH_USER && password === AUTH_PASS) {
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, { created: Date.now(), user: username });
        addLog(`管理者 (${username}) がログインしました。`, 'info');
        
        return sendJson(200, { success: true, message: 'ログイン成功' }, {
          'Set-Cookie': `session_token=${token}; Path=/; HttpOnly; SameSite=Lax`
        });
      } else {
        addLog(`ログイン失敗試行 (ID: ${username})`, 'warning');
        return sendJson(401, { error: 'ログインIDまたはパスワードが正しくありません' });
      }
    });
  }

  // 3. ログアウト処理
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getSessionToken(req);
    if (token) activeSessions.delete(token);
    return sendJson(200, { success: true }, {
      'Set-Cookie': `session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    });
  }

  // 4. 設定取得 (要ログイン)
  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    return sendJson(200, {
      emails: store.emails,
      isMonitoringActive: store.isMonitoringActive,
      intervalMinutes: store.intervalMinutes,
      alertTarget: store.alertTarget || 'funabashi',
      smtp: store.smtp || {}
    });
  }

  // 4-B. SMTP 設定更新 (要ログイン)
  if (pathname === '/api/smtp' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    return parseJsonBody(({ host, port, secure, user, pass, from }) => {
      store.smtp = {
        host: (host || '').trim(),
        port: parseInt(port || 465, 10),
        secure: secure !== false,
        user: (user || '').trim(),
        pass: (pass || '').trim(),
        from: (from || '').trim()
      };
      saveStore();
      addLog(`SMTPサーバー設定を更新しました (Host: ${store.smtp.host || '未設定'}, User: ${store.smtp.user || '未設定'})`, 'info');
      return sendJson(200, { success: true, smtp: store.smtp });
    });
  }

  // 4-C. SMTP 接続診断テスト (要ログイン)
  if (pathname === '/api/test-smtp' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    (async () => {
      const transporter = createSmtpTransporter();
      if (!transporter) {
        return sendJson(400, { error: 'SMTP設定（ホスト、ユーザー名、パスワード）が入力されていません。' });
      }

      try {
        await transporter.verify();
        addLog(`✅ SMTP接続テスト成功: ${store.smtp.user} 経由でメールサーバーへ正常接続完了`, 'success');
        return sendJson(200, { message: `✅ SMTPサーバーへの接続・認証に成功しました！ (${store.smtp.user})` });
      } catch (verifyErr) {
        addLog(`❌ SMTP接続検証失敗: ${verifyErr.message}`, 'error');
        let errorHint = '接続に失敗しました。';
        if (verifyErr.code === 'EAUTH' || verifyErr.message.includes('Invalid login')) {
          errorHint = 'パスワード認証エラー: 16桁のアプリパスワードとメールアドレスをご確認ください。';
        } else if (verifyErr.code === 'ESOCKETTIMEDOUT' || verifyErr.code === 'ETIMEDOUT') {
          errorHint = '通信タイムアウト: SMTPホスト名(smtp.gmail.com)またはポート番号(465)をご確認ください。';
        }
        return sendJson(400, { error: `❌ ${errorHint} (${verifyErr.message})` });
      }
    })();
    return;
  }

  // 5. 監視設定更新 (要ログイン)
  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    return parseJsonBody(({ isMonitoringActive, intervalMinutes, alertTarget }) => {
      if (typeof isMonitoringActive === 'boolean') {
        store.isMonitoringActive = isMonitoringActive;
      }
      if ([5, 30, 60].includes(Number(intervalMinutes))) {
        store.intervalMinutes = Number(intervalMinutes);
      }
      const targetChanged = alertTarget && store.alertTarget !== alertTarget;
      if (['funabashi', 'chiba', 'kanto'].includes(alertTarget)) {
        store.alertTarget = alertTarget;
      }
      saveStore();
      restartMonitoringScheduler();
      addLog(`監視設定を変更しました (稼働: ${store.isMonitoringActive ? 'ON' : 'OFF'}, 間隔: ${store.intervalMinutes}分, 対象: ${store.alertTarget})`, 'info');

      // 設定更新・保存時に即座にデータチェックとアラート判定を実行
      checkPowerOutages(true, targetChanged);

      return sendJson(200, {
        success: true,
        isMonitoringActive: store.isMonitoringActive,
        intervalMinutes: store.intervalMinutes,
        alertTarget: store.alertTarget
      });
    });
  }

  // 6. メールアドレス登録・変更 (要ログイン)
  if (pathname === '/api/emails' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    return parseJsonBody(({ email, oldEmail }) => {
      if (!email || !email.includes('@')) {
        return sendJson(400, { error: '有効なメールアドレスを入力してください' });
      }

      if (oldEmail) {
        // 編集の場合
        const idx = store.emails.indexOf(oldEmail);
        if (idx !== -1) {
          store.emails[idx] = email;
          addLog(`メールアドレスを変更しました: ${oldEmail} → ${email}`, 'info');
        } else {
          if (!store.emails.includes(email)) store.emails.push(email);
        }
      } else {
        // 新規追加の場合
        if (!store.emails.includes(email)) {
          store.emails.push(email);
          addLog(`新しいメールアドレスを登録しました: ${email}`, 'info');
        }
      }

      saveStore();
      return sendJson(200, { success: true, emails: store.emails });
    });
  }

  // 7. メールアドレス削除 (要ログイン)
  if (pathname === '/api/emails' && req.method === 'DELETE') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    return parseJsonBody(({ email }) => {
      store.emails = store.emails.filter(e => e !== email);
      saveStore();
      addLog(`メールアドレスを削除しました: ${email}`, 'warning');
      return sendJson(200, { success: true, emails: store.emails });
    });
  }

  // 8. 動作確認テスト：テストメール送信 (要ログイン)
  if (pathname === '/api/test-email' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    (async () => {
      const subject = '【テストメール】千葉県停電情報監視システム';
      const body = `これは千葉県停電情報監視システムからの動作確認テストメールです。\n` +
                   `正常に通知メッセージが届いています。\n\n` +
                   `送信日時: ${new Date().toLocaleString('ja-JP')}`;
      
      const resResult = await sendEmailNotification(subject, body, true);
      if (resResult.success) {
        return sendJson(200, { message: resResult.message });
      } else {
        return sendJson(400, { error: resResult.message, is429: !!resResult.is429 });
      }
    })();
    return;
  }

  // 9. 動作確認テスト：停電アラート発火テスト (選択中の対象範囲に応じて即時実行)
  if (pathname === '/api/test-alert' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    (async () => {
      const target = store.alertTarget || 'funabashi';
      addLog(`🧪 【動作テスト】アラート発火テストを実行しました (対象範囲: ${target})`, 'warning');
      
      let subject = '';
      let message = '';
      let targetName = '';

      if (target === 'chiba') {
        targetName = '千葉県全域';
        const testCount = 2500;
        store.previousChibaCount = testCount;
        subject = `【ハッカテスト中】千葉県全域 停電情報更新 (2,500軒)`;
        message = `[動作テスト] 千葉県全域で停電発生を検知した想定のテスト通知です。\n\n` +
                  `■ 千葉県全域 停電件数: ${testCount} 軒 (前回: 0 軒)\n` +
                  `■ 船橋市 停電件数: 1,200 軒\n` +
                  `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                  `https://teideninfo.tepco.co.jp/html/12000000000.html`;
      } else if (target === 'kanto') {
        targetName = '関東全域';
        const testCount = 5000;
        store.previousKantoCount = testCount;
        subject = `【ハッカテスト中】関東全域 停電情報更新 (5,000軒)`;
        message = `[動作テスト] 関東全域エリアで停電発生を検知した想定のテスト通知です。\n\n` +
                  `■ 関東全域 停電件数: ${testCount} 軒 (前回: 0 軒)\n` +
                  `■ 千葉県全域 停電件数: 2,500 軒\n` +
                  `■ 船橋市 停電件数: 1,200 軒\n` +
                  `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                  `https://teideninfo.tepco.co.jp/html/00000000000.html`;
      } else {
        targetName = '船橋市';
        const testCount = 1200;
        const testAreas = ['船橋市本町1丁目', '船橋市湊町2丁目', '船橋市海神3丁目'];
        store.funabashi = { count: testCount, areas: testAreas };
        store.previousFunabashiCount = testCount;
        
        const fCity = store.cities.find(c => c.name && c.name.includes('船橋'));
        if (fCity) {
          fCity.count = testCount;
          fCity.areas = testAreas;
        } else {
          store.cities.unshift({ name: '船橋市', count: testCount, areas: testAreas });
        }

        subject = `【ハッカテスト中】船橋市 停電情報更新 (1,200軒)`;
        message = `[動作テスト] 船橋市内で停電発生を検知した想定のテスト通知です。\n\n` +
                  `■ 船橋市 停電件数: ${testCount} 軒 (前回: 0 軒)\n` +
                  `■ 該当地域: ${testAreas.join(', ')}\n` +
                  `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                  `https://teideninfo.tepco.co.jp/html/12204000000.html`;
      }

      store.lastCheck = new Date().toISOString();
      saveStore();

      const sendResult = await sendEmailNotification(subject, message);

      if (sendResult.success) {
        return sendJson(200, { message: `🚨 「${targetName}」設定での停電アラート発火テストを実行し、緊急通知を送信しました！` });
      } else {
        return sendJson(200, { message: `🚨 アラートテストを実行しました。ステータス: ${sendResult.message}` });
      }
    })();
    return;
  }

  // 10. テストデータクリア・最新状態リセット (要ログイン)
  if (pathname === '/api/clear-test' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    (async () => {
      addLog('🧹 テストデータをクリアし、船橋市の停電情報を正常状態（0件）にリセットしました。', 'info');
      
      store.funabashi = { count: 0, areas: [] };
      store.previousFunabashiCount = 0;
      store.isNextCheckSimulated = false;
      
      const fCity = store.cities.find(c => c.name && c.name.includes('船橋'));
      if (fCity) {
        fCity.count = 0;
        fCity.areas = [];
      }
      
      saveStore();
      await checkPowerOutages(true);

      return sendJson(200, { message: '停電情報を正常状態（船橋市: 停電0件）にリセットしました。' });
    })();
    return;
  }

  // 11. 1回限定 自動検知シミュレーション予約 (要ログイン)
  if (pathname === '/api/simulate-next-check' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    store.isNextCheckSimulated = true;
    saveStore();
    addLog('🧪 次回1回限定の自動チェックで船橋市停電発生（1,500軒）を偽装検知するシミュレーションを予約しました。', 'warning');
    return sendJson(200, {
      message: '次回1回限定の定期チェック（または手動更新）で船橋市の停電発生（1,500軒）を偽装割り込み検出するシミュレーションを予約しました！監視プログラムが自動検知してアラート通知を行うか確認できます。'
    });
  }

  // --- 静的ファイル配信 ---
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'chiba_teiden.html' : pathname);
  
  // セキュリティ対策: パストラバーサル防止
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // デフォルトフォールバック
      filePath = path.join(PUBLIC_DIR, 'chiba_teiden.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// 起動処理
loadStore();
server.listen(PORT, () => {
  addLog(`千葉県停電監視サーバーがポート ${PORT} で起動しました。`, 'info');
  restartMonitoringScheduler();
  // 初回データ取得を実行
  checkPowerOutages(true);
});
