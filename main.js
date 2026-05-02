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
    
    const launcher = new Client()
    
    const launchOpts = {
      authorization: Authenticator.getAuth(opts.username),
      root: path.join(os.homedir(), '.craftmix'),
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
    
    if (opts.autoconnect) {
      launchOpts.quickPlay = {
        type: 'multiplayer',
        identifier: 'play.craftmix.net'
      }
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
