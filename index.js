const { app, BrowserWindow, shell, ipcMain, remote } = require('electron')
const path = require('path')
const fmgconvert = require('./fmgconvert')
let _win;
/*
if (process.argv.length>1) {
    const args = process.argv
    require('./fmgconvert')(args[args.length-2],args[args.length-1])
}*/
app?.on('ready',()=>{
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
ipcMain?.on('convert',(e,f,s)=>fmgconvert(f,s,_win))
