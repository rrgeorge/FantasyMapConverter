const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const fmgconvert = require('./fmgconvert')
let _win;
app.on('ready',()=>{
    _win = new BrowserWindow({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })
    _win.loadURL(`file://${__dirname}/index.html`)
    _win.webContents.on('will-navigate',(e,u)=>{
        if (u.startsWith("http")) {
            e.preventDefault()
            shell.openExternal(u)
        }
    })
})
ipcMain.on('convert',(e,f,s)=>fmgconvert(f,s,_win))
