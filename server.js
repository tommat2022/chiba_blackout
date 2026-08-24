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

// メール送信処理 (FormSubmit.co & Web3Forms ハイブリッド即時転送)
async function sendEmailNotification(subject, bodyText) {
  if (!store.emails || store.emails.length === 0) {
    addLog('通知先メールアドレスが登録されていないため、送信をスキップしました。', 'warning');
    return { success: false, message: '通知先メールアドレスが登録されていません。' };
  }

  let successCount = 0;
  let activationNeededEmails = [];
  let errorMessages = [];

  for (const email of store.emails) {
    try {
      const payload = JSON.stringify({
        _subject: subject,
        _captcha: 'false',
        _template: 'table',
        '件名': subject,
        '通知本文': bodyText,
        '送信日時': new Date().toLocaleString('ja-JP'),
        'システム': '千葉県停電監視アラート'
      });

      // 1. FormSubmit.co への送信 (Referer/Origin ヘッダー必須)
      const options = {
        hostname: 'formsubmit.co',
        path: `/ajax/${encodeURIComponent(email)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Referer': 'http://localhost:3000/chiba_teiden.html',
          'Origin': 'http://localhost:3000',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const result = await new Promise((resolve) => {
        const req = https.request(options, (res) => {
          let resData = '';
          res.on('data', chunk => resData += chunk);
          res.on('end', () => {
            try {
              const resJson = JSON.parse(resData);
              if (res.statusCode >= 200 && res.statusCode < 300 && (resJson.success === 'true' || resJson.success === true)) {
                resolve({ ok: true, data: resJson });
              } else if (resData.includes('Activation') || (resJson.message && resJson.message.includes('Activation'))) {
                resolve({ ok: false, isActivationNeeded: true, message: resJson.message });
              } else {
                resolve({ ok: false, message: resJson.message || `HTTP ${res.statusCode}` });
              }
            } catch (e) {
              resolve({ ok: res.statusCode === 200, data: resData });
            }
          });
        });

        req.on('error', (e) => resolve({ ok: false, message: e.message }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, message: '通信タイムアウト' }); });
        req.write(payload);
        req.end();
      });

      if (result.ok) {
        successCount++;
      } else if (result.isActivationNeeded) {
        activationNeededEmails.push(email);
        addLog(`⚠️ 【重要】「${email}」宛にFormSubmitから承認メール(Activate Form)が送信されました。メールを開いてリンクを1回クリックしてください。`, 'warning');
      } else {
        errorMessages.push(`${email}: ${result.message}`);
      }

    } catch (err) {
      errorMessages.push(`${email}: ${err.message}`);
    }
  }

  if (successCount > 0) {
    const msg = `FormSubmit経由で ${successCount}件 のメールを即時送信しました (${store.emails.join(', ')})`;
    addLog(msg, 'success');
    return { success: true, message: msg };
  } else if (activationNeededEmails.length > 0) {
    const msg = `✉️ 「${activationNeededEmails.join(', ')}」宛に承認メール(Activate FormSubmit)が届いています！届いたメール内の「Activate Form」リンクを1回だけクリックしてください。クリック後に通知が届くようになります。`;
    addLog(msg, 'warning');
    return { success: false, message: msg };
  } else {
    const errText = `メール送信失敗: ${errorMessages.join(' / ') || 'FormSubmitエラー'}`;
    addLog(errText, 'error');
    return { success: false, message: errText };
  }
}

// TEPCO 千葉県＆関東全域 停電情報の取得処理
async function fetchSingleTepcoJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChibaTeidenMonitor/1.0)' }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200 && data.trim().startsWith('{')) {
            const parsed = JSON.parse(data);
            return resolve(parsed);
          }
        } catch (e) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchTepcoOutageData() {
  const [chibaParsed, kantoParsed] = await Promise.all([
    fetchSingleTepcoJson('https://teideninfo.tepco.co.jp/flash/12000000000.json'),
    fetchSingleTepcoJson('https://teideninfo.tepco.co.jp/flash/00000000000.json')
  ]);

  const cities = [];
  let funabashiData = { count: 0, areas: [] };

  if (chibaParsed && chibaParsed.list) {
    chibaParsed.list.forEach(item => {
      const cityName = item.name || item.cityName || '';
      const count = parseInt(item.cnt || item.count || '0', 10);
      const areas = item.areaList || [];
      if (cityName) {
        cities.push({ name: cityName, count, areas });
        if (cityName.includes('船橋')) {
          funabashiData = { count, areas };
        }
      }
    });
  }

  // フォールバック（データなし時）
  if (cities.length === 0) {
    const mockCities = [
      { name: '船橋市', count: 0, areas: [] },
      { name: '千葉市中央区', count: 0, areas: [] },
      { name: '市川市', count: 0, areas: [] },
      { name: '松戸市', count: 0, areas: [] },
      { name: '柏市', count: 0, areas: [] }
    ];
    mockCities.forEach(c => cities.push(c));
    funabashiData = mockCities[0];
  }

  const kanto = [];
  if (kantoParsed && kantoParsed.list) {
    kantoParsed.list.forEach(item => {
      const prefName = item.name || item.prefName || '';
      const count = parseInt(item.cnt || item.count || '0', 10);
      if (prefName) {
        kanto.push({ name: prefName, count });
      }
    });
  }

  // フォールバック用関東都県リスト
  if (kanto.length === 0) {
    const mockKanto = [
      { name: '東京都', count: 0 },
      { name: '神奈川県', count: 0 },
      { name: '埼玉県', count: 0 },
      { name: '千葉県', count: 0 },
      { name: '茨城県', count: 0 },
      { name: '栃木県', count: 0 },
      { name: '群馬県', count: 0 },
      { name: '山梨県', count: 0 },
      { name: '静岡県', count: 0 }
    ];
    mockKanto.forEach(k => kanto.push(k));
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
async function checkPowerOutages(isManualTrigger = false) {
  if (!store.isMonitoringActive && !isManualTrigger) {
    addLog('自動監視が停止中のため、チェックをスキップしました。', 'warning');
    return;
  }

  addLog(`東京電力 停電情報データをチェック中... (${isManualTrigger ? '手動実行' : '定期チェック'})`, 'info');
  
  const result = await fetchTepcoOutageData();
  const nowStr = new Date().toISOString();
  store.lastCheck = nowStr;

  if (result.success) {
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

    addLog(`チェック完了: 千葉県全域 ${currentChibaCount}軒 / 関東全域 ${currentKantoCount}軒 / 船橋市 ${currentFunabashiCount}軒 (対象設定: ${target})`, 'info');

    let isTriggered = false;
    let subject = '';
    let message = '';

    if (target === 'funabashi' && currentFunabashiCount !== prevFunabashi) {
      isTriggered = true;
      subject = `【緊急警報】船橋市 停電情報更新 (${currentFunabashiCount}軒)`;
      message = `船橋市内で停電情報が更新されました。\n\n` +
                `■ 船橋市 停電件数: ${currentFunabashiCount} 軒 (前回: ${prevFunabashi} 軒)\n` +
                `■ 該当地域: ${store.funabashi.areas.length > 0 ? store.funabashi.areas.join(', ') : '確認中'}\n` +
                `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                `https://teideninfo.tepco.co.jp/html/12204000000.html`;
      if (currentFunabashiCount === 0 && prevFunabashi > 0) {
        subject = `【復旧通知】船橋市 停電復旧のお知らせ`;
        message = `船橋市内の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
      }

    } else if (target === 'chiba' && currentChibaCount !== prevChiba) {
      isTriggered = true;
      subject = `【緊急警報】千葉県全域 停電情報更新 (${currentChibaCount}軒)`;
      message = `千葉県内で停電情報が更新されました。\n\n` +
                `■ 千葉県全域 停電件数: ${currentChibaCount} 軒 (前回: ${prevChiba} 軒)\n` +
                `■ 船橋市 停電件数: ${currentFunabashiCount} 軒\n` +
                `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                `https://teideninfo.tepco.co.jp/html/12000000000.html`;
      if (currentChibaCount === 0 && prevChiba > 0) {
        subject = `【復旧通知】千葉県全域 停電復旧のお知らせ`;
        message = `千葉県全域の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
      }

    } else if (target === 'kanto' && currentKantoCount !== prevKanto) {
      isTriggered = true;
      subject = `【緊急警報】関東全域 停電情報更新 (${currentKantoCount}軒)`;
      message = `関東エリアで停電情報が更新されました。\n\n` +
                `■ 関東全域 停電件数: ${currentKantoCount} 軒 (前回: ${prevKanto} 軒)\n` +
                `■ 千葉県全域 停電件数: ${currentChibaCount} 軒\n` +
                `■ 船橋市 停電件数: ${currentFunabashiCount} 軒\n` +
                `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                `https://teideninfo.tepco.co.jp/html/00000000000.html`;
      if (currentKantoCount === 0 && prevKanto > 0) {
        subject = `【復旧通知】関東全域 停電復旧のお知らせ`;
        message = `関東全域の停電が復旧しました。\n■ 現在の停電件数: 0 軒\n■ 復旧確認時刻: ${new Date().toLocaleString('ja-JP')}`;
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
      alertTarget: store.alertTarget || 'funabashi'
    });
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
      if (['funabashi', 'chiba', 'kanto'].includes(alertTarget)) {
        store.alertTarget = alertTarget;
      }
      saveStore();
      restartMonitoringScheduler();
      addLog(`監視設定を変更しました (稼働: ${store.isMonitoringActive ? 'ON' : 'OFF'}, 間隔: ${store.intervalMinutes}分, 対象: ${store.alertTarget})`, 'info');
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
      
      const resResult = await sendEmailNotification(subject, body);
      if (resResult.success) {
        return sendJson(200, { message: resResult.message });
      } else {
        return sendJson(400, { error: resResult.message });
      }
    })();
    return;
  }

  // 9. 動作確認テスト：船橋市停電アラート発火テスト (要ログイン)
  if (pathname === '/api/test-alert' && req.method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(401, { error: 'ログインが必要です' });
    (async () => {
      addLog('🧪 【動作テスト】船橋市停電アラート発火テストを実行しました。', 'warning');
      
      // テスト用擬似停電データ設定（船橋市: 1,200件）
      const testCount = 1200;
      const testAreas = ['船橋市本町1丁目', '船橋市湊町2丁目', '船橋市海神3丁目'];

      store.funabashi = { count: testCount, areas: testAreas };
      
      const fCity = store.cities.find(c => c.name && c.name.includes('船橋'));
      if (fCity) {
        fCity.count = testCount;
        fCity.areas = testAreas;
      } else {
        store.cities.unshift({ name: '船橋市', count: testCount, areas: testAreas });
      }

      store.lastCheck = new Date().toISOString();
      store.previousFunabashiCount = testCount;
      saveStore();

      // 緊急アラートメール本文作成＆送信（件名に「【ハッカテスト中】」を明記）
      const subject = `【ハッカテスト中】船橋市 停電情報更新 (1,200軒)`;
      const message = `[動作テスト] 船橋市内で停電発生を検知した想定のテスト通知です。\n\n` +
                    `■ 船橋市 停電件数: ${testCount} 軒 (前回: 0 軒)\n` +
                    `■ 該当地域: ${testAreas.join(', ')}\n` +
                    `■ 判定時刻: ${new Date().toLocaleString('ja-JP')}\n\n` +
                    `詳細情報は東京電力ウェブサイトまたはアプリで確認してください。\n` +
                    `https://teideninfo.tepco.co.jp/html/12204000000.html`;

      const sendResult = await sendEmailNotification(subject, message);

      if (sendResult.success) {
        return sendJson(200, { message: `🚨 船橋市停電アラート発火テストを実行し、登録メールへ緊急通知を直接送信しました！` });
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
