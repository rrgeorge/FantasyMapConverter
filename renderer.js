const { remote, ipcRenderer } = require('electron');
const map = document.querySelector("#mapfile");
const svg = document.querySelector("#mapsvg");
const form = document.querySelector("#form");
form.addEventListener('submit',(e)=>{
    e.preventDefault()
    const file = document.querySelector("#mapfile").files[0]?.path
    const svg = document.querySelector("#mapsvg").files[0]?.path
    ipcRenderer.send("convert",file,svg)
})
