const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLE_CSV_PATH = path.join(__dirname, 'sample_emis.csv');
const DATA_DIR = path.join(__dirname, 'data');
const LATEST_CSV_PATH = path.join(DATA_DIR, 'latest_emis.csv');

// サーバー内インメモリ共有データ（Renderなどのディスク再構築・権限問題対策）
let sharedCsvText = "";

// 起動時に最新CSVまたはサンプルCSVをメモリに読み込み
function loadInitialCsv() {
  try {
    if (fs.existsSync(LATEST_CSV_PATH)) {
      sharedCsvText = fs.readFileSync(LATEST_CSV_PATH, 'utf-8');
      console.log('最新CSVをディスクからロードしました');
    } else if (fs.existsSync(SAMPLE_CSV_PATH)) {
      sharedCsvText = fs.readFileSync(SAMPLE_CSV_PATH, 'utf-8');
      console.log('サンプルCSVをロードしました');
    }
  } catch (err) {
    console.error('初期CSV読み込みエラー:', err);
  }
}
loadInitialCsv();

// MIMEタイプマッピング
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=UTF-8'
};

const server = http.createServer((req, res) => {
  // CORSヘッダー設定 & キャッシュ防止
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // URLのパース
  const reqUrl = req.url.split('?')[0];

  // === API: 最新CSVデータの取得（全端末用） ===
  if (req.method === 'GET' && (reqUrl === '/api/latest-csv' || reqUrl === '/api/sample-csv')) {
    // データがメモリ上にない場合は再ロードを試みる
    if (!sharedCsvText) {
      loadInitialCsv();
    }

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(sharedCsvText || '');
    return;
  }

  // === API: PC等のアップロード端末から最新CSVデータをサーバーへ保存 ===
  if (req.method === 'POST' && reqUrl === '/api/upload-csv') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        if (!body || body.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '送信データが空です' }));
          return;
        }

        // 1. サーバーのメモリ上に即座に最新データを保存（確実な同期）
        sharedCsvText = body;

        // 2. ディスクにもファイルとして書き込み保存
        try {
          if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
          }
          fs.writeFileSync(LATEST_CSV_PATH, body, 'utf-8');
        } catch (fsErr) {
          console.warn('ディスクへの書き込み失敗（メモリ上の最新データは保持されています）:', fsErr);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '最新データを全端末共有ストアに保存しました', length: body.length }));
      } catch (err) {
        console.error('アップロード処理エラー:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 静的ファイル提供 (SPAルーティング)
  let filePath = path.join(PUBLIC_DIR, reqUrl === '/' ? 'index.html' : reqUrl);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`EMIS Summary App running on port ${PORT}`);
});
