const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { Client, Authenticator } = require('minecraft-launcher-core')
const path = require('path')
const os = require('os')
const fs = require('fs')
const https = require('https')
const { spawn, exec } = require('child_process')

let mainWindow

// === JAVA AUTO DOWNLOAD ===
const JAVA_DIR = path.join(os.homedir(), '.craftmix', 'runtime', 'java21')
// Adoptium Temurin JRE 21 - Windows x64
// API endpoint, gives us latest stable
const JAVA_DOWNLOAD_URL = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'

function findJavaExecutable() {
  // Önce kendi indirdiğimiz Java'yı kontrol et
  if (fs.existsSync(JAVA_DIR)) {
    try {
      const items = fs.readdirSync(JAVA_DIR)
      for (const item of items) {
        const itemPath = path.join(JAVA_DIR, item)
        if (fs.statSync(itemPath).isDirectory()) {
          const javaExe = path.join(itemPath, 'bin', 'javaw.exe')
          const javaCmd = path.join(itemPath, 'bin', 'java.exe')
          if (fs.existsSync(javaExe)) return javaExe
          if (fs.existsSync(javaCmd)) return javaCmd
        }
      }
    } catch (e) {}
  }
  return null
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    let downloaded = 0
    
    function get(currentUrl) {
      https.get(currentUrl, (response) => {
        // Redirect handling
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close()
          fs.unlink(destPath, () => {})
          const file2 = fs.createWriteStream(destPath)
          file._stream = file2
          return get(response.headers.location)
        }
        
        if (response.statusCode !== 200) {
          file.close()
          fs.unlink(destPath, () => {})
          return reject(new Error('HTTP ' + response.statusCode))
        }
        
        const total = parseInt(response.headers['content-length'] || '0', 10)
        
        response.on('data', (chunk) => {
          downloaded += chunk.length
          if (onProgress && total > 0) {
            onProgress({ task: downloaded, total: total, type: 'Java İndiriliyor' })
          }
        })
        
        const stream = file._stream || file
        response.pipe(stream)
        stream.on('finish', () => {
          stream.close(() => resolve(destPath))
        })
        stream.on('error', (err) => {
          fs.unlink(destPath, () => {})
          reject(err)
        })
      }).on('error', (err) => {
        fs.unlink(destPath, () => {})
        reject(err)
      })
    }
    
    get(url)
  })
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Windows built-in PowerShell ile unzip (ek paket gerekmez)
    const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

async function ensureJava(onProgress, onLog) {
  // Önce kendi runtime'da var mı kontrol et
  let javaPath = findJavaExecutable()
  if (javaPath) {
    onLog && onLog('Java bulundu: ' + javaPath)
    return javaPath
  }
  
  // Sistemde java var mı?
  onLog && onLog('Java aranıyor...')
  const sysJava = await new Promise((resolve) => {
    exec('java -version', (err) => {
      resolve(err ? null : 'java')
    })
  })
  
  if (sysJava) {
    onLog && onLog('Sistem Java\'sı kullanılacak')
    return sysJava
  }
  
  // Java yok, indirelim
  onLog && onLog('Java bulunamadı, indiriliyor (45 MB)...')
  
  // Klasör oluştur
  fs.mkdirSync(JAVA_DIR, { recursive: true })
  const zipPath = path.join(JAVA_DIR, 'jre.zip')
  
  // İndir
  try {
    await downloadFile(JAVA_DOWNLOAD_URL, zipPath, onProgress)
    onLog && onLog('Java indirildi, açılıyor...')
  } catch (e) {
    onLog && onLog('Java indirme hatası: ' + e.message)
    throw e
  }
  
  // Unzip
  try {
    await extractZip(zipPath, JAVA_DIR)
    onLog && onLog('Java açıldı')
    fs.unlinkSync(zipPath)
  } catch (e) {
    onLog && onLog('Java açma hatası: ' + e.message)
    throw e
  }
  
  // Tekrar bul
  javaPath = findJavaExecutable()
  if (!javaPath) {
    throw new Error('Java kuruldu ama bulunamadı')
  }
  
  onLog && onLog('Java hazır: ' + javaPath)
  return javaPath
}

// === MC OPTIONS (TÜRKÇE + OPTİMİZE) ===
function ensureMinecraftOptions(mcRoot, onLog) {
  try {
    const optionsPath = path.join(mcRoot, 'options.txt')
    
    // Default Türkçe ve optimize ayarlar
    const defaults = {
      'lang': 'tr_tr',
      'forceUnicodeFont': '0',
      'autoJump': 'false',
      'fancyGraphics': 'true',
      'tutorialStep': 'none',
      'joinedFirstServer': 'true',
      'narrator': '0',
      'soundCategory_master': '1.0',
      'fov': '0.0',
      'gamma': '1.0'
    }
    
    let existingLines = []
    let existingKeys = new Set()
    
    if (fs.existsSync(optionsPath)) {
      const content = fs.readFileSync(optionsPath, 'utf8')
      existingLines = content.split(/\r?\n/).filter(line => line.trim())
      existingLines.forEach(line => {
        const idx = line.indexOf(':')
        if (idx > 0) existingKeys.add(line.substring(0, idx))
      })
    }
    
    // Eksik defaults'ları ekle (mevcut ayarları override etme)
    for (const [key, value] of Object.entries(defaults)) {
      if (!existingKeys.has(key)) {
        existingLines.push(`${key}:${value}`)
      }
    }
    
    // İlk açılışta lang:tr_tr garantili olsun (override)
    if (!fs.existsSync(optionsPath)) {
      // Yeni dosya, lang kesinlikle tr_tr olsun
    } else {
      // Mevcut dosya varsa lang ayarını güncelle
      existingLines = existingLines.map(line => {
        if (line.startsWith('lang:')) return 'lang:tr_tr'
        if (line.startsWith('tutorialStep:')) return 'tutorialStep:none'
        if (line.startsWith('joinedFirstServer:')) return 'joinedFirstServer:true'
        return line
      })
    }
    
    fs.mkdirSync(mcRoot, { recursive: true })
    fs.writeFileSync(optionsPath, existingLines.join('\n') + '\n', 'utf8')
    onLog && onLog('🇹🇷 Türkçe dil ayarı uygulandı')
  } catch (e) {
    onLog && onLog('options.txt hatası: ' + e.message)
  }
}

// servers.dat - sunucu listesinde sadece CraftMix olsun (her launch'ta yenile)
function ensureServerInList(mcRoot, onLog) {
  try {
    const serversPath = path.join(mcRoot, 'servers.dat')
    
    // NBT formatında binary dosya - sadece CraftMix Skyblock!
    // Her launch'ta üzerine yaz - oyuncu başka sunucu eklese bile kayıt edilmez
    const buf = Buffer.from([
      0x0a, 0x00, 0x00,                                                       // Compound (root)
      0x09, 0x00, 0x07, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0x73,             // List "servers"
      0x0a, 0x00, 0x00, 0x00, 0x01,                                           // 1 compound
      0x08, 0x00, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x00, 0x12,                   // String "name", length 18
      0x43, 0x72, 0x61, 0x66, 0x74, 0x4d, 0x69, 0x78, 0x20, 0x53, 0x6b, 0x79, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x21, // "CraftMix Skyblock!"
      0x08, 0x00, 0x02, 0x69, 0x70, 0x00, 0x11,                               // String "ip", length 17
      0x70, 0x6c, 0x61, 0x79, 0x2e, 0x63, 0x72, 0x61, 0x66, 0x74, 0x6d, 0x69, 0x78, 0x2e, 0x6e, 0x65, 0x74, // "play.craftmix.net"
      0x00,                                                                   // End of compound
      0x00                                                                    // End of root
    ])
    
    fs.mkdirSync(mcRoot, { recursive: true })
    
    // Mevcut servers.dat varsa önce read-only flag'ini kaldır (üzerine yazabilmek için)
    if (fs.existsSync(serversPath)) {
      try { fs.chmodSync(serversPath, 0o644) } catch(e) {}
    }
    
    fs.writeFileSync(serversPath, buf)
    
    // Windows'ta dosyayı read-only yap (MC değiştiremez, oyuncu sunucu ekleyemez)
    try {
      fs.chmodSync(serversPath, 0o444) // read-only
    } catch(e) {}
    
    onLog && onLog('🔒 Sunucu listesi kilitlendi (sadece CraftMix)')
  } catch (e) {
    onLog && onLog('servers.dat hatası: ' + e.message)
  }
}

// === ELECTRON ===
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    title: 'CraftMix Launcher',
    resizable: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0a05',
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile('index.html')
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('launch-minecraft', async (event, opts) => {
  try {
    // Java'yı bul/indir
    mainWindow.webContents.send('mc-log', { type: 'info', msg: '☕ Java kontrol ediliyor...' })
    
    const javaPath = await ensureJava(
      (progress) => mainWindow.webContents.send('mc-progress', progress),
      (msg) => mainWindow.webContents.send('mc-log', { type: 'info', msg: msg })
    )
    
    mainWindow.webContents.send('mc-log', { type: 'success', msg: '✓ Java hazır, oyun başlatılıyor...' })
    
    const mcRoot = path.join(os.homedir(), '.craftmix')
    
    // Türkçe dil + sunucu listeye ekle
    ensureMinecraftOptions(mcRoot, (msg) => mainWindow.webContents.send('mc-log', { type: 'info', msg: msg }))
    ensureServerInList(mcRoot, (msg) => mainWindow.webContents.send('mc-log', { type: 'info', msg: msg }))
    
    const launcher = new Client()
    
    const launchOpts = {
      authorization: Authenticator.getAuth(opts.username),
      root: mcRoot,
      version: {
        number: '1.21.8',
        type: 'release'
      },
      memory: {
        max: opts.ram + 'G',
        min: '2G'
      },
      javaPath: javaPath,
      overrides: {
        detached: true
      }
    }
    
    // Otomatik bağlantı her zaman aktif (CraftMix-only kilit)
    launchOpts.quickPlay = {
      type: 'multiplayer',
      identifier: 'play.craftmix.net'
    }
    
    if (opts.fullscreen) {
      launchOpts.window = { fullscreen: true }
    }
    
    launcher.launch(launchOpts)
    
    launcher.on('debug', (e) => mainWindow.webContents.send('mc-log', { type: 'debug', msg: String(e) }))
    launcher.on('data', (e) => mainWindow.webContents.send('mc-log', { type: 'data', msg: String(e) }))
    launcher.on('progress', (e) => mainWindow.webContents.send('mc-progress', e))
    launcher.on('close', (code) => mainWindow.webContents.send('mc-closed', code))
    
    return { success: true }
  } catch (err) {
    mainWindow.webContents.send('mc-log', { type: 'error', msg: 'Hata: ' + err.message })
    throw err
  }
})

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close()
})

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url)
})
