const fs = require('fs');
const readline = require("readline")
const { v5: uuid5 } = require('uuid')
const { toXML } = require('jstoxml')
const AdmZip = require('adm-zip')
const puppeteer = require('puppeteer-core')
const path = require('path')
const md = require('markdown-it')()
    .use(require('markdown-it-multimd-table'))
    .use(require('markdown-it-fontawesome'))
    .use(require('markdown-it-attrs'))
    .use(require('markdown-it-anchor'))
    .use(require('markdown-it-imsize'), { autofill: true })
const slugify = (s)=>require('slugify')(s,{ lower: true, strict: true })
const coa = require('./coa-renderer')
const Voronoi = require('./voronoi')
const d3 = require('d3')
const Delaunator = require('delaunator')
const querystring = require("querystring");
const { BrowserWindow, dialog } = require('electron')
const { 
 getBoundaryPoints,
 getJitteredGrid,
 findGridCell,
 findGridAll,
 find,
 findCell,
 findAll,
 getPackPolygon,
 getGridPolygon,
 poissonDiscSampler,
 isLand,
 isWater,
 drawCellsValue,
 drawPolygons
} = require('./graphUtils');

let grid = {}
let distanceUnit = "mi"
let distanceScale = 3
let areaUnit = "square"
let heightUnit = "ft"
let heightExponent = 2
let temperatureScale = "°F"

function convertTemperature(temp) {
  switch (temperatureScale) {
    case "°C":
      return temp + "°C";
    case "°F":
      return rn((temp * 9) / 5 + 32) + "°F";
    case "K":
      return rn(temp + 273.15) + "K";
    case "°R":
      return rn(((temp + 273.15) * 9) / 5) + "°R";
    case "°De":
      return rn(((100 - temp) * 3) / 2) + "°De";
    case "°N":
      return rn((temp * 33) / 100) + "°N";
    case "°Ré":
      return rn((temp * 4) / 5) + "°Ré";
    case "°Rø":
      return rn((temp * 21) / 40 + 7.5) + "°Rø";
    default:
      return temp + "°C";
  }
}
function rn(v, d = 0) {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

function minmax(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// return value in range [0, 100]
function lim(v) {
  return minmax(v, 0, 100);
}

// normalization function
function normalize(val, min, max) {
  return minmax((val - min) / (max - min), 0, 1);
}
function getHeight(h, abs) {
  const unit = heightUnit;
  let unitRatio = 3.281; // default calculations are in feet
  if (unit === "m") unitRatio = 1;
  // if meter
  else if (unit === "f") unitRatio = 0.5468; // if fathom

  let height = -990;
  if (h >= 20) height = Math.pow(h - 18, +heightExponent);
  else if (h < 20 && h > 0) height = ((h - 20) / h) * 50;

  if (abs) height = Math.abs(height);
  return rn(height * unitRatio) + " " + unit;
}
function calculateVoronoi(graph, points) {
  //TIME && console.time("calculateDelaunay");
  const n = points.length;
  const allPoints = points.concat(grid.boundary);
  const delaunay = Delaunator.from(allPoints);
  //TIME && console.timeEnd("calculateDelaunay");

  //TIME && console.time("calculateVoronoi");
  const voronoi = new Voronoi(delaunay, allPoints, n);
  graph.cells = voronoi.cells;
  graph.cells.i = n < 65535 ? Uint16Array.from(d3.range(n)) : Uint32Array.from(d3.range(n)); // array of indexes
  graph.vertices = voronoi.vertices;
  //TIME && console.timeEnd("calculateVoronoi");
}
function reGraph() {
//  TIME && console.time("reGraph");
  let {cells, points, features} = grid;
  const newCells = {p: [], g: [], h: []}; // to store new data
  const spacing2 = grid.spacing ** 2;

  for (const i of cells.i) {
    const height = cells.h[i];
    const type = cells.t[i];
    if (height < 20 && type !== -1 && type !== -2) continue; // exclude all deep ocean points
    if (type === -2 && (i % 4 === 0 || features[cells.f[i]].type === "lake")) continue; // exclude non-coastal lake points
    const [x, y] = points[i];

    addNewPoint(i, x, y, height);

    // add additional points for cells along coast
    if (type === 1 || type === -1) {
      if (cells.b[i]) continue; // not for near-border cells
      cells.c[i].forEach(function (e) {
        if (i > e) return;
        if (cells.t[e] === type) {
          const dist2 = (y - points[e][1]) ** 2 + (x - points[e][0]) ** 2;
          if (dist2 < spacing2) return; // too close to each other
          const x1 = rn((x + points[e][0]) / 2, 1);
          const y1 = rn((y + points[e][1]) / 2, 1);
          addNewPoint(i, x1, y1, height);
        }
      });
    }
  }

  function addNewPoint(i, x, y, height) {
    newCells.p.push([x, y]);
    newCells.g.push(i);
    newCells.h.push(height);
  }
  calculateVoronoi(pack, newCells.p);
  cells = pack.cells;
  cells.p = newCells.p; // points coordinates [x, y]
  cells.g = grid.cells.i.length < 65535 ? Uint16Array.from(newCells.g) : Uint32Array.from(newCells.g); // reference to initial grid cell
  cells.q = d3.quadtree(cells.p.map((p, d) => [p[0], p[1], d])); // points quadtree for fast search
  cells.h = new Uint8Array(newCells.h); // heights
  cells.area = new Uint16Array(cells.i.length); // cell area
  cells.i.forEach(i => (cells.area[i] = Math.abs(d3.polygonArea(getPackPolygon(i)))));

//  TIME && console.timeEnd("reGraph");
}

function reMarkFeatures() {
//  TIME && console.time("reMarkFeatures");
  const cells = pack.cells,
    features = (pack.features = [0]);
  cells.f = new Uint16Array(cells.i.length); // cell feature number
  cells.t = new Int8Array(cells.i.length); // cell type: 1 = land along coast; -1 = water along coast;
  cells.haven = cells.i.length < 65535 ? new Uint16Array(cells.i.length) : new Uint32Array(cells.i.length); // cell haven (opposite water cell);
  cells.harbor = new Uint8Array(cells.i.length); // cell harbor (number of adjacent water cells);

  const defineHaven = i => {
    const water = cells.c[i].filter(c => cells.h[c] < 20);
    const dist2 = water.map(c => (cells.p[i][0] - cells.p[c][0]) ** 2 + (cells.p[i][1] - cells.p[c][1]) ** 2);
    const closest = water[dist2.indexOf(Math.min.apply(Math, dist2))];

    cells.haven[i] = closest;
    cells.harbor[i] = water.length;
  };

  for (let i = 1, queue = [0]; queue[0] !== -1; i++) {
    const start = queue[0]; // first cell
    cells.f[start] = i; // assign feature number
    const land = cells.h[start] >= 20;
    let border = false; // true if feature touches map border
    let cellNumber = 1; // to count cells number in a feature

    while (queue.length) {
      const q = queue.pop();
      if (cells.b[q]) border = true;
      cells.c[q].forEach(function (e) {
        const eLand = cells.h[e] >= 20;
        if (land && !eLand) {
          cells.t[q] = 1;
          cells.t[e] = -1;
          if (!cells.haven[q]) defineHaven(q);
        } else if (land && eLand) {
          if (!cells.t[e] && cells.t[q] === 1) cells.t[e] = 2;
          else if (!cells.t[q] && cells.t[e] === 1) cells.t[q] = 2;
        }
        if (!cells.f[e] && land === eLand) {
          queue.push(e);
          cells.f[e] = i;
          cellNumber++;
        }
      });
    }

    const type = land ? "island" : border ? "ocean" : "lake";
    let group;
    if (type === "ocean") group = defineOceanGroup(cellNumber);
    else if (type === "island") group = defineIslandGroup(start, cellNumber);
    features.push({i, land, border, type, cells: cellNumber, firstCell: start, group});
    queue[0] = cells.f.findIndex(f => !f); // find unmarked cell
  }

  // markupPackLand
  markup(pack.cells, 3, 1, 0);

  function defineOceanGroup(number) {
    if (number > grid.cells.i.length / 25) return "ocean";
    if (number > grid.cells.i.length / 100) return "sea";
    return "gulf";
  }

  function defineIslandGroup(cell, number) {
    if (cell && features[cells.f[cell - 1]].type === "lake") return "lake_island";
    if (number > grid.cells.i.length / 10) return "continent";
    if (number > grid.cells.i.length / 1000) return "island";
    return "isle";
  }

//  TIME && console.timeEnd("reMarkFeatures");
}
function markup(cells, start, increment, limit) {
  for (let t = start, count = Infinity; count > 0 && t > limit; t += increment) {
    count = 0;
    const prevT = t - increment;
    for (let i = 0; i < cells.i.length; i++) {
      if (cells.t[i] !== prevT) continue;

      for (const c of cells.c[i]) {
        if (cells.t[c]) continue;
        cells.t[c] = t;
        count++;
      }
    }
  }
}

module.exports = (mapfile,mapsvg,win=null) => {
    fs.readFile(mapfile,async (err,data)=>{
        if (err) { console.log(err); return }
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(),"fmg"))
        if (!fs.existsSync(puppeteer.executablePath())) {
            const browserFetcher = puppeteer.createBrowserFetcher({})
            await browserFetcher.download("901912",(v,m)=>{
                if (win?.webContents)
                    win.webContents.executeJavaScript(`
                        document.querySelector('#form').style.display = "none";
                        document.querySelector('#progress').style.display = "block";
                        document.querySelector('#progressBar').style.display = "unset";
                        document.querySelector('#progressText').textContent = "Downloading Chromium";
                        document.querySelector('#progressImage').style.display = "none";
                        document.querySelector('#progressBar').value = ${v};
                        document.querySelector('#progressBar').max = ${m};
                        `)
                else
                    console.log(v,'/',m)
            })
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressText').textContent = "Preparing...";
                    document.querySelector('#progressBar').removeAttribute('value');
                    document.querySelector('#progressBar').removeAttribute('max');
                    `)
        }
        const browser = await puppeteer.launch({args: ['--disable-web-security']})
        const page = await browser.newPage()
        const mapPage = await browser.newPage()
        await page.setDefaultTimeout(0)
        await mapPage.setDefaultTimeout(0)
        const mapConversion = new Promise((resolve,reject)=>{
            fs.readFile(mapsvg,(e,d)=>{
                if (e) { console.log(e); return }
                const svg = d.toString()
                const tmpsvgpage = path.join(tmp,"mapsvg.html")
                fs.writeFile(tmpsvgpage,`<!DOCTYPE html><html><head><style>* { margin: 0; padding: 0; }</style></head><body>${svg}</body></html>`,()=>{
                    mapPage.goto(`file://${tmpsvgpage}`)
                        .then(()=>mapPage.waitForSelector('svg')
                            .then(mapPage.evaluate(()=>{
                                const s = document.querySelector('svg')
                                let width = parseInt(s?.getAttribute('width')||1000)
                                let height = parseInt(s?.getAttribute('height')||1000)
                                /*
                                const scale = (width>height)?8192/width:8192/height
                                    width=parseInt(scale*width)
                                    height=parseInt(scale*height)
                                    s.setAttribute('width',width)
                                    s.setAttribute('height',height)
                                    */
                                return {width,height}
                            })
                                .then(size=>mapPage.setViewport({width: size.width,height: size.height, deviceScaleFactor: (size.width>size.height)?8192/size.width:8192/size.height})
                                    .then(()=>mapPage.screenshot({type: 'webp'})
                                        .then(image=>{
                                            fs.unlink(tmpsvgpage,()=>{})
                                            mapPage.close()
                                            resolve(image)
                                        })))))
                })
            })
        })
        page.on('console', (msg) => console.log('PAGE LOG:', msg.text(),msg));
        const convert = async (svg)=>{
            const tmpsvgpage = path.join(tmp,"svg.html")
            fs.writeFileSync(tmpsvgpage,`<!DOCTYPE html><html><head><style>* { margin: 0; padding: 0; }</style></head><body>${svg}</body></html>`)
            await page.goto(`file://${tmpsvgpage}`)
            await page.waitForSelector('svg')
            size = await page.evaluate(()=>
                {
                    const s = document.querySelector('svg')
                    const width = parseInt(s?.getAttribute('width')||1000)
                    const height = parseInt(s?.getAttribute('height')||1000)
                    return {width,height}
                }
            )
            await page.setViewport(size)
            const image = await page.screenshot({type: 'webp',omitBackground: true})
            fs.unlinkSync(tmpsvgpage)
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressImage').src = "data:image/webp;base64,${image.toString('base64')}";
                    `)
            return image
        }
        const decoded = data.toString().split("\r\n")
        const meta = decoded[0].split('|')
        const settings = decoded[1].split('|')
        const baseW = meta[4]
        const baseH = meta[5]
        const seed = parseInt(meta[3])
        const scale = 8192/baseW
        const continent = settings[20]
        const url = `https://azgaar.github.io/Fantasy-Map-Generator/${continent}`
        const uuid = uuid5(url,uuid5.URL)
        if (win?.webContents)
            win.webContents.executeJavaScript(`
                document.querySelector('#form').style.display = "none";
                document.querySelector('#progress').style.display = "block";
                document.querySelector('#progressBar').style.display = "unset";
                document.querySelector('#progressText').textContent = "Generating module for ${continent}";
                document.querySelector('#progressDetail').textContent = "Converting map...";
                document.querySelector('#progressImage').style.display = "none";
                document.querySelector('#progressBar').removeAttribute('value');
                document.querySelector('#progressBar').removeAttribute('max');
                `)
        else
            console.log(`Generating module for ${continent}`)
        const mapimage = await mapConversion
        if (win?.webContents)
            win.webContents.executeJavaScript(`
                    document.querySelector('#progressImage').style.display = "unset";
                    document.querySelector('#progressImage').src = "data:image/webp;base64,${mapimage.toString('base64')}";
                `)
        if (settings[0]) distanceUnit = settings[0]
        if (settings[1]) distanceScale = Number(settings[1])
        if (settings[2]) areaUnit = settings[2]
        if (settings[3]) heightUnit = settings[3]
        if (settings[4]) heightExponent = Number(settings[4])
        if (settings[5]) temperatureScale = settings[5]
        if (settings[12]) populationRate = settings[12];
        if (settings[13]) urbanization = settings[13];
        if (settings[24]) urbanDensity = +settings[24];

        let mapmarkers = [
            { name: continent },
            { name: slugify(continent) },
            { gridSize: parseInt(((distanceScale*25)/Math.sqrt(3))*scale) },
            { gridOffsetY: parseInt(((distanceScale*25)/Math.sqrt(3))*scale*-1) },
            { gridScale: distanceScale*25 },
            { gridUnits: distanceUnit },
            { gridType: "hexPointy" },
            { gridStyle: "solid" },
            { gridOpacity: 1.0 },
            { scale: 1.0 },
            { fogOfWar: 'YES' },
            { fogExploration: 'YES' },
            { lineOfSight: 'NO' },
            { image: `${continent}_map.webp` }
        ]
        let mod = {
            _name: "module",
            _attrs: { id: uuid },
            _content: [
                { name: continent },
                { author: "Azgaar Fantasy Map Generator" },
                { slug: slugify(continent) },
                { image: `${continent}_map.webp` },
                { _name: "map", _attrs: { id: uuid5("MapObject",uuid) }, _content: mapmarkers}
            ]
        }
        let moduleinfo = `id: ${uuid}\n`
            + `name: ${continent}\n`
            + `slug: ${slugify(continent)}\n`
            + `cover: ${continent}_map.webp\n`
            + `maps:\n`
            + ' - path: map.zip\n'
            + '   order: 4\n'
            + `   slug: ${slugify(continent)}\n`

        grid = JSON.parse(decoded[6]);
        calculateVoronoi(grid,grid.points);
        grid.cells.h = Uint8Array.from(decoded[7].split(","));
        grid.cells.prec = Uint8Array.from(decoded[8].split(","));
        grid.cells.f = Uint16Array.from(decoded[9].split(","));
        grid.cells.t = Int8Array.from(decoded[10].split(","));
        grid.cells.temp = Int8Array.from(decoded[11].split(","));
        pack = {}
        console.log("ReGraphing")
        reGraph();
        console.log("ReMarkingFeatures")
        reMarkFeatures();
        pack.features = JSON.parse(decoded[12]);
        pack.cultures = JSON.parse(decoded[13]);
        pack.states = JSON.parse(decoded[14]);
        pack.burgs = JSON.parse(decoded[15]);
        pack.religions = decoded[29] ? JSON.parse(decoded[29]) : [{i: 0, name: "No religion"}];
        pack.provinces = decoded[30] ? JSON.parse(decoded[30]) : [0];
        pack.rivers = decoded[32] ? JSON.parse(decoded[32]) : [];
        pack.markers = decoded[35] ? JSON.parse(decoded[35]) : [];
        const features = pack.features
        const cultures = pack.cultures
        const states = pack.states
        const burgs = pack.burgs
        const religions = pack.religions
        const provinces = pack.provinces
        const rivers = pack.rivers
        const markers = pack.markers
        const notes = JSON.parse(decoded[4])
        const cells = pack.cells;
        const namesDL = decoded[31].split("/");
        let nameBases = []
        namesDL.forEach((d, i) => {
          const e = d.split("|");
          if (!e.length) return;
          const b = e[5].split(",").length > 2 || !nameBases[i] ? e[5] : nameBases[i].b;
          nameBases[i] = {name: e[0], min: e[1], max: e[2], d: e[3], m: e[4], b};
        });
        cells.biome = Uint8Array.from(decoded[16].split(","));
        cells.burg = Uint16Array.from(decoded[17].split(","));
        cells.conf = Uint8Array.from(decoded[18].split(","));
        cells.culture = Uint16Array.from(decoded[19].split(","));
        cells.fl = Uint16Array.from(decoded[20].split(","));
        cells.pop = Float32Array.from(decoded[21].split(","));
        cells.r = Uint16Array.from(decoded[22].split(","));
        cells.road = Uint16Array.from(decoded[23].split(","));
        cells.s = Uint16Array.from(decoded[24].split(","));
        cells.state = Uint16Array.from(decoded[25].split(","));
        cells.religion = decoded[26] ? Uint16Array.from(decoded[26].split(",")) : new Uint16Array(cells.i.length);
        cells.province = decoded[27] ? Uint16Array.from(decoded[27].split(",")) : new Uint16Array(cells.i.length);
        cells.crossroad = decoded[28] ? Uint16Array.from(decoded[28].split(",")) : new Uint16Array(cells.i.length);
        const getSI = (n) => d3.format(".2s")(n)
        
        function getMFCGlink(burg) {
          const {cells} = pack;
          const {name, population, cell} = burg;
          const burgSeed = Number(`${seed}${String(burg.i).padStart(4, 0)}`);
          const sizeRaw = 2.13 * Math.pow((population * populationRate) / urbanDensity, 0.385);
          const size = minmax(Math.ceil(sizeRaw), 6, 100);
          const people = rn(population * populationRate * urbanization);
          const hub = +cells.road[cell] > 50;
          const river = cells.r[cell] ? 1 : 0;

          const coast = +burg.port;
          const citadel = +burg.citadel;
          const walls = +burg.walls;
          const plaza = +burg.plaza;
          const temple = +burg.temple;
          const shanty = +burg.shanty;

          const sea = coast && cells.haven[cell] ? getSeaDirections(cell) : "";
          function getSeaDirections(i) {
            const p1 = cells.p[i];
            const p2 = cells.p[cells.haven[i]];
            let deg = (Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180) / Math.PI - 90;
            if (deg < 0) deg += 360;
            const norm = rn(normalize(deg, 0, 360) * 2, 2); // 0 = south, 0.5 = west, 1 = north, 1.5 = east
            return "&sea=" + norm;
          }

          const baseURL = "https://watabou.github.io/city-generator/?random=0&continuous=0";
          const url = `${baseURL}&name=${querystring.escape(name)}&population=${people}&size=${size}&seed=${burgSeed}&hub=${hub}&river=${river}&coast=${coast}&citadel=${citadel}&plaza=${plaza}&temple=${temple}&walls=${walls}&shantytown=${shanty}${sea}`;
          return url;
        }
        const nationgroup = uuid5(slugify("Nations"),uuid)
        mod._content.push({ group: {
            _attrs: { id: nationgroup },
            name: "Nations",
            slug: slugify("Nations")
        } })
        const culturegroup = uuid5(slugify("Cultures"),uuid)
        mod._content.push({ group: {
            _attrs: { id: culturegroup },
            name: "Cultures",
            slug: slugify("Cultures")
        } })
        const religiongroup = uuid5(slugify("Religions"),uuid)
        mod._content.push({ group: {
            _attrs: { id: religiongroup },
            name: "Religions",
            slug: slugify("Religions")
        } })
        console.log(`Processing ${states.length} states:`)
        const module = new AdmZip()
        let progress = 0
        for (const state of states) {
            if (state.removed) continue
            const stateName = state.fullName||state.name
            const stateSlug = slugify(stateName)
            const stateId = uuid5(stateSlug,uuid)
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressDetail').textContent = "Processing ${stateName}";
                    document.querySelector('#progressBar').max = 1;
                    document.querySelector('#progressBar').value = ${progress};
                    `)
            else
                console.log(`->${stateName}`)
            state.coa && module.addFile(`images/coa/s/${stateSlug}.webp`,await convert(await coa.trigger(stateSlug,state.coa)))
            const pageInfo = '---\n'
                + `name: ${stateName}\n`
                + `slug: ${stateSlug}\n`
                + `id: ${stateId}\n`
                + `order: ${state.i}\n`
                + '---\n'
            const pageContent = `| ${stateName}  ||\n`
                + `${(state.coa)?`| ![${stateName}](images/coa/s/${stateSlug}.webp =300x){.center} ||\n`:''}`
                + '|----------------|-----------------|\n'
                + `| **Government:**   | ${state.form} |\n`
                + `${(state.capital)?`| **Capital:**   | [![${burgs[state.capital]?.name}](images/coa/b/burg-${slugify(burgs[state.capital]?.name)}.webp =25x) ${burgs[state.capital]?.name}](/page/burg-${slugify(burgs[state.capital]?.name)}) |\n`:''}`
                + `| **Population** | ${getSI((state.urban+state.rural)*populationRate)} *(${getSI(state.urban*populationRate)} urban, ${getSI(state.rural*populationRate)} rural)* |\n`
                + `${(state.area>0)?`| **Area:**       | ${getSI(state.area * distanceScale ** 2)} ${distanceUnit}²   |\n`:''}`
                + `${(state.provinces.length>0)?`| **Provinces:**   ||\n| ${state.provinces.map(p=>{
                    if (provinces[p].removed) return ''
                    const n = provinces[p].fullName||provinces[p].name
                    return `[![${n}](images/coa/p/province-${slugify(n)}.webp =25x) ${n}](/page/province-${slugify(n)})`
                    }).filter(f=>f).join(' ||\n| ')}   ||\n`:''}`
                + `${(state.i>0)?`| **Diplomatic Relations:**   ||\n| ${state.diplomacy.map((d,s)=>{
                    if (states[s].removed||d=='x') return
                    const n = states[s].fullName||states[s].name
                    return `[![${n}](images/coa/s/${slugify(n)}.webp =25x) ${n}](/page/${slugify(n)}) | ${d}`
                    }).filter(f=>f).join(' |\n| ')}   |\n`:''}`
                + `{.header-title-fancy}\n`
            module.addFile(`Nations/${stateSlug}.md`,pageInfo+pageContent)
            mod._content.push({ page: {
                _attrs: { id: stateId, parent: nationgroup, sort: state.i },
                name: stateName,
                slug: stateSlug,
                content: md.render(pageContent)
                } })
            state.pole && mapmarkers.push( { marker: {
                name: state.fullName||state.name,
                color: state.color,
                shape: "label",
                size: "huge",
                hidden: "YES",
                locked: "YES",
                x: parseInt(state.pole[0]*scale),
                y: parseInt(state.pole[1]*scale),
                content: { _attrs: { ref: `/page/${stateSlug}` } }
            } } )
            if (state.provinces.length===0)
                progress += (1/states.length)
            for(const province of state.provinces) {
                const p = provinces[province]
                if (p.removed) continue
                const pName = p.fullName||p.name
                const pSlug = "province-"+slugify(pName)
                const pId = uuid5(pSlug,uuid)
                if (win?.webContents)
                    win.webContents.executeJavaScript(`
                        document.querySelector('#progressDetail').textContent = "Processing ${stateName}: ${pName}";
                        document.querySelector('#progressBar').value = ${progress};
                        `)
                else
                    console.log(`  -> ${pName}`)
                let urban = 0
                let rural = 0
                for (let i = 0; i<cells.province.length; i++) {
                    if (cells.province[i] === p.i) {
                        if (burgs.find(b=>b.cell===i))
                            urban += burgs.find(b=>b.cell===i).population
                        rural += cells.pop[i]
                    }
                }
                p.coa && module.addFile(`images/coa/p/${pSlug}.webp`,await convert(await coa.trigger(pSlug,p.coa)))
                const pageInfo = '---\n'
                    + `name: ${pName}\n`
                    + `slug: ${pSlug}\n`
                    + `id: ${pId}\n`
                    + `parent: ${stateSlug}\n`
                    + `order: ${p.i}\n`
                    + '---\n'
                const pageContent = `| ${pName}  ||\n`
                    + `| *[${stateName}](/page/${stateSlug})* ||\n`
                    + `${(p.coa)?`| ![${pName}](images/coa/p/${pSlug}.webp =300x){.center} ||\n`:''}`
                    + '|----------------|-----------------|\n'
                    + `${(p.burg)?`| **Capital:**   | [![${burgs[p.burg]?.name}](images/coa/b/burg-${slugify(burgs[p.burg]?.name)}.webp =25x) ${burgs[p.burg]?.name}](/page/burg-${slugify(burgs[p.burg]?.name)})   |\n`:''}`
                    + `| **Population** | ${getSI((urban+rural)*populationRate)} *(${getSI(urban*populationRate)} urban, ${getSI(rural*populationRate)} rural)* |\n`
                    + `${(p.area>0)?`| **Area:**       | ${getSI(p.area * distanceScale ** 2)} ${distanceUnit}²   |\n`:''}`
                    + `${(p.burgs?.filter(b=>b!=p.burg).length>0)?`| **Towns:**   ||\n| ${p.burgs.filter(b=>b!=p.burg).map(b=>{
                        const n = burgs[b].name
                        return `[![${n}](images/coa/b/burg-${slugify(n)}.webp =25x) ${n}](/page/burg-${slugify(n)})`
                        }).filter(f=>f).join(' ||\n| ')}   ||\n`:''}`
                    + `{.header-title-fancy}\n`
                module.addFile(`Nations/${pSlug}.md`,pageInfo+pageContent)
                mod._content.push( { page: {
                    _attrs: { id: pId, parent: stateId, sort: p.i },
                    name: pName,
                    slug: pSlug,
                    content: md.render(pageContent)
                } } )
                mapmarkers.push( { marker: {
                    name: p.fullName||p.name,
                    color: p.color,
                    shape: "label",
                    size: "medium",
                    hidden: "YES",
                    locked: "YES",
                    x: parseInt(p.pole[0]*scale),
                    y: parseInt(p.pole[1]*scale),
                    content: { _attrs: { ref: `/page/${pSlug}` } }
                } } )
                const pBurgs = burgs.filter(b=>cells.province[b.cell]===p.i)
                if (pBurgs.length===0)
                    progress += (1/states.length)*(1/state.provinces.length)
                for (let b of pBurgs) {
                    if (b.removed) continue
                    progress += (1/states.length)*(1/state.provinces.length)*(1/pBurgs.length)
                    let bSlug = "burg-"+slugify(b.name)
                    let bId = uuid5(bSlug,uuid)
                    if (win?.webContents)
                        win.webContents.executeJavaScript(`
                            document.querySelector('#progressDetail').textContent = "Processing ${stateName}: ${pName} (${b.name})";
                            `)
                    const MFCGLink = getMFCGlink(b)
                    b.coa && module.addFile(`images/coa/b/${bSlug}.webp`,await convert(await coa.trigger(bSlug,b.coa)))
                    const pageInfo = '---\n'
                        + `name: ${b.name}\n`
                        + `slug: ${bSlug}\n`
                        + `id: ${bId}\n`
                        + `parent: ${pSlug}\n`
                        + `order: ${b.i}\n`
                        + '---\n'
                    const pageContent = `| ${b.name}  ||\n`
                        + `| *[${pName}](/page/${pSlug}), [${stateName}](/page/${stateSlug})* ||\n`
                        + `${(b.coa)?`| ![${b.name}](images/coa/b/${bSlug}.webp =300x){.center} ||\n`:''}`
                        + '|------------------|-----------------|\n'
                        + `| **Type:**        | ${b.type} |\n`
                        + `| **Culture:**     | [${cultures[b.culture].name}](culture-${slugify(cultures[b.culture].name)}) |\n`
                        + `| **Population:**  | ${getSI(b.population*populationRate)} |\n`
                        + `| **Elevation:**   | ${getHeight(pack.cells.h[b.cell])} |\n`
                        + `| **Temperature:** | ${convertTemperature(grid.cells.temp[pack.cells.g[b.cell]])} |\n`
                        + `| **Features:**    | *:fas-star:*${(!+b.capital)?'{.gray}':''} *:fas-anchor:*${(!+b.port)?'{.gray}':''} *:fas-chess-rook:*${(!+b.walls)?'{.gray}':''} *:fab-fort-awesome:*${(!+b.citadel)?'{.gray}':''} *:fas-store:*${(!+b.plaza)?'{.gray}':''} *:fas-chess-bishop:*${(!+b.temple)?'{.gray}':''} *:fas-campground:*${(!+b.shanty)?'{.gray}':''} |\n`
                        + `{.header-title-fancy}\n\n`
                        + `[View in City Generator by Watabou](${MFCGLink})\n`
                        + `<iframe sandbox="allow-scripts allow-same-origin" style="pointer-events: none; border: 0; width: 100%; height: 50vh" src="${MFCGLink}"></iframe>`
                    module.addFile(`Nations/${bSlug}.md`,pageInfo+pageContent)
                    mod._content.push( { page: {
                        _attrs: { id: bId, parent: pId, sort: b.i },
                        name: b.name,
                        slug: bSlug,
                        content: md.render(pageContent)
                    } } )
                    mapmarkers.push( { marker: {
                        name: b.name,
                        color: '#ff0000',
                        shape: "circle",
                        label: (b.capital)?"\u2B50":(b.port)?"\u2693":"",
                        size: (b.capital)? "small":"small",//"tiny",
                        hidden: "YES",
                        locked: "YES",
                        x: parseInt(b.x*scale),
                        y: parseInt(b.y*scale),
                        content: { _attrs: { ref: `/page/${bSlug}` } }
                    } } )
                }
            }
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressBar').value = ${progress};
                    `)
        }
        if (win?.webContents)
            win.webContents.executeJavaScript(`
                document.querySelector('#progressBar').value = .999999;
                `)
        for (let c of cultures) {
            if (c.removed) continue
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressDetail').textContent = "${c.name} Culture";
                    `)
            const cSlug = 'culture-'+slugify(c.name)
            const cId = uuid5(cSlug,uuid)
            const cReligions = religions.filter(r=>r.culture===c.i)
            const pageInfo = '---\n'
                + `name: ${c.name}\n`
                + `slug: ${cSlug}\n`
                + `id: ${cId}\n`
                + `order: ${c.i}\n`
                + '---\n'
            const pageContent = `| ${c.name}  ||\n`
                + '|------------------|-----------------|\n'
                + `| **Type:**        | ${c.type} |\n`
                + `| **Etymology:**   | ${nameBases[c.base].name} |\n`
                + `| **Population:**  | ${getSI((c.urban+c.rural)*populationRate)} *(${getSI(c.urban*populationRate)} urban, ${getSI(c.rural*populationRate)} rural)* |\n`
                + `${(cReligions.length>0)?`| **Religions:**   | ${cReligions.map(r=>
                    `[${r.name}](/page/religion-${slugify(r.name)})`)
                        .join(' |\n|      |')} |`:''}`
                + `{.header-title-fancy}`
            module.addFile(`Cultures/${cSlug}.md`,pageInfo+pageContent)
            mod._content.push({ page: {
                _attrs: { id: cId, parent: culturegroup, sort: c.i },
                name: c.name,
                slug: cSlug,
                content: md.render(pageContent)
            } })
        }
        for (let marker of pack.markers) {
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressDetail').textContent = "Marker: ${notes.find(n=>n.id==`marker${marker.i}`)?.name||marker.type}";
                    `)
            mapmarkers.push( { marker: {
                name: notes.find(n=>n.id==`marker${marker.i}`)?.name||marker.type,
                label: marker.icon,
                color: '#ff00ff',
                shape: "marker",
                size: "small",
                hidden: "YES",
                locked: "YES",
                x: parseInt(marker.x*scale),
                y: parseInt(marker.y*scale),
                description: notes.find(n=>n.id==`marker${marker.i}`)?.legend||marker.type,
            } } )
        }
        for (let r of religions) {
            if (r.removed) continue
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressDetail').textContent = "${r.name} Religion";
                    `)
            const rSlug = 'religion-'+slugify(r.name)
            const rId = uuid5(rSlug,uuid)
            const pageInfo = '---\n'
                + `name: ${r.name}\n`
                + `slug: ${rSlug}\n`
                + `id: ${rId}\n`
                + `order: ${r.i}\n`
                + '---\n'
            const pageContent = `| ${r.name}  ||\n`
                + '|------------------|-----------------|\n'
                + `${(r.type)?`| **Type** | ${r.type} |\n`:''}`
                + `${(r.form && r.form!=r.type)?`| **Form** | ${r.form} |\n`:''}`
                + `${(r.deity)?`| **Deity** | ${r.deity} |\n`:''}`
                + `| **Population:**  | ${getSI((r.urban+r.rural)*populationRate)} *(${getSI(r.urban*populationRate)} urban, ${getSI(r.rural*populationRate)} rural)* |\n`
                + `{.header-title-fancy}\n`
            module.addFile(`Religions/${rSlug}.md`,pageInfo+pageContent)
            mod._content.push({ page: {
                _attrs: { id: rId, parent: religiongroup, sort: r.i },
                name: r.name,
                slug: rSlug,
                content: md.render(pageContent)
            } })
        }
        if (win?.webContents)
            win.webContents.executeJavaScript(`
                document.querySelector('#progressDetail').textContent = "Finishing module assembly";
                `)
        console.log("Adding module.xml")
        module.addFile('module.xml',toXML(mod,{indent:'\t'}))
        console.log("Adding Module.yaml")
        module.addFile('Module.yaml',moduleinfo)
        module.addFile('images/Group.yaml','include-in: files')
        module.addFile('Nations/Group.yaml','slug: nations')
        module.addFile('Cultures/Group.yaml','slug: cultures')
        module.addFile('Religions/Group.yaml','slug: religions')
        console.log("Adding global.css from the module-packer")
        const https = require('https')
        await new Promise((resolve,reject)=>{
            https.get("https://raw.githubusercontent.com/encounterplus/module-packer/master/source/assets/base/css/global.css",res=>{
                if (res.statusCode!=200) reject(res)
                let b = ""
                res.on('data',(d)=>b=b.concat(d))
                res.on('end',()=>{
                    module.addFile("assets/css/global.css",b)
                    resolve()
                })
            })
        }).catch(e=>console.log(e))
        console.log("Adding font-awesome")
        module.addLocalFile(path.join(require.resolve('@fortawesome/fontawesome-free'),"../../css/all.min.css"),"assets/css/fontawesome/css")
        module.addLocalFolder(path.join(require.resolve('@fortawesome/fontawesome-free'),"../../webfonts"),"assets/css/fontawesome/webfonts")
        console.log("Adding Dungeon Drop Case and custom.css")
        module.addLocalFile('Dungeon Drop Case.otf','assets/fonts')
        module.addFile("assets/css/custom.css",`@import 'fontawesome/css/all.min.css';
    @font-face {
        font-family: 'Dungeon Drop Case';
        src: 
            url('../fonts/Dungeon Drop Case.otf') format("opentype");
    }
    em.gray {
        color: lightgray
    }
    table.header-title-fancy thead tr:first-child {
      font-size: 4.2rem;
      line-height: 3.4rem;
      padding-bottom: 0.5rem;
      font-family: 'Dungeon Drop Case', '-apple-system', sans-serif;
      color: #58180d;
    }
        `)
        console.log("Adding map")
        module.addFile(`${continent}_map.webp`,mapimage)
        const mapModule = new AdmZip()
        mapModule.addFile('module.xml',toXML(mod))
        mapModule.addFile(`${continent}_map.webp`,mapimage)
        module.addFile('map.zip',mapModule.toBuffer())
        console.log("Saving module")
        let destination = `${continent}.module`
        if (win)
            destination = (await dialog.showSaveDialog(win, {
                title: "Save module",
                filters: [ { name: "EncounterPlus Module", extensions: ["module"]},
                    {name: "ZIP File", extensions: ["zip"] } ],
                message: "Please choose where to save the completed .module",
                defaultPath: destination
            })).filePath
        console.log(destination)
        if (destination) {
            module.writeZip(`${continent}.module`)
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressBar').value = 1;
                    document.querySelector('#progressText').textContent = "Finished creating module for ${continent}";
                    document.querySelector('#progressDetail').textContent = "Module saved as ${destination}";
                    document.querySelector('#form').style.display = "block";
                    document.querySelector("#mapfile").value = null;
                    document.querySelector("#mapsvg").value = null;
                    `)
        } else {
            console.log("Save aborted.")
            if (win?.webContents)
                win.webContents.executeJavaScript(`
                    document.querySelector('#progressBar').value = 1;
                    document.querySelector('#form').style.display = "block";
                    document.querySelector('#progressText').textContent = "Canceled module for ${continent}";
                    document.querySelector('#progressDetail').textContent = "Aborted. Module not saved.";
                    `)
        }
        await browser.close()
        fs.rmdirSync(tmp)
        if (win?.webContents)
            win.webContents.executeJavaScript(`
                document.querySelector('#progressBar').style.display = 'none';
                `)
    })
}
