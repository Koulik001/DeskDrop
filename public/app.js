const deviceType = /Mobi|Android/i.test(navigator.userAgent)? "mobile": "desktop"
const protocol = location.protocol === "https:"? "wss": "ws"
const WS_URL = `${protocol}://${location.host}/ws?deviceType=${deviceType}`

let ws
let retries = 0
let myDeviceId = null
const devices = new Map()
let clipboardTargets = 'all'

let isSending = false

let activeReceive = null
// IndexedDB — single shared connection opened on first receive
let db = null

const CHUNK_SIZE = 65536
const MAX_FILE_SIZE = 500 * 1024 * 1024

const ADJECTIVES = [
    'swift',  'bright', 'calm',  'bold',  'keen',
    'wise',   'warm',   'cool',  'sharp', 'quiet',
    'brave',  'fresh',  'light', 'soft',  'wild',
]

const ANIMALS = [
    'panda', 'tiger', 'eagle', 'fox',  'wolf',
    'bear',  'hawk',  'lion',  'deer', 'seal',
    'crane', 'raven', 'lynx',  'orca', 'kite',
]

function deviceLabel(deviceId) {
    const adj = parseInt(deviceId[0], 16) % ADJECTIVES.length
    const animal = parseInt(deviceId[2], 16) % ANIMALS.length

    return `${ADJECTIVES[adj]} ${ANIMALS[animal]}`
}

function debounce(fn, delay) {
    let timer = null
    return function (...args){
        clearTimeout(timer)
        timer = setTimeout(()=>fn.apply(this, args), delay)
    }
}

function generateTransferId(){
    if(crypto.randomUUID) return crypto.randomUUID()

    return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function readChunkAsBuffer(file, offset, size){
    return new Promise((resolve, reject)=> {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target.result)
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(file.slice(offset, offset + size))
    })
}

function openDB(){
    if(db) return Promise.resolve(db)

    return new Promise((resolve, reject) => {
        const request = indexedDB.open('deskdrop-db', 1)

        request.onupgradeneeded = (event) => {
            const database = event.target.result
            
            if (!database.objectStoreNames.contains('chunks')) {
                database.createObjectStore('chunks')
            }
        }

        request.onsuccess = (event) => {
            db = event.target.result
            
            const tx    = db.transaction('chunks', 'readwrite')
            const store = tx.objectStore('chunks')
            store.clear()
            tx.oncomplete = () => {
                console.log('[IDB] cleared stale chunks from previous session')
                resolve(db)
            }

            tx.onerror = () => {
                resolve(db)
            }
        }

        request.onerror = (event) => {
            console.error('[IDB] failed to open database', event.target.error)
            reject(event.target.error)
        }
    })
}

function writeChunk(transferId, chunkIndex, buffer){
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('chunks', 'readwrite')
        const store = transaction.objectStore('chunks')
        const request = store.put(buffer, `${transferId}-${chunkIndex}`)
            request.onsuccess = () => resolve()
        request.onerror = (e) => reject(e.target.error)
    })
}

function readAllChunks(transferId, totalChunks){
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('chunks', 'readonly')
        const store = transaction.objectStore('chunks')
        const chunks = new Array(totalChunks)
        let completed = 0
        let hasError = false

        for(let i = 0; i < totalChunks; i++){
            const index = i
            const request = store.get(`${transferId}-${index}`)

            request.onsuccess = (event) => {
                if(hasError) return
                chunks[index] = event.target.result
                completed++
                if(completed === totalChunks) resolve(chunks)
            }

            request.onerror = (event) => {
                if(hasError) return 
                hasError = true
                reject(event.target.error)
            }
        }
    })
}   

function deleteChunks(transferId, totalChunks){
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('chunks', 'readwrite')
        const store = transaction.objectStore('chunks')
        for(let i = 0; i < totalChunks; i++){
            store.delete(`${transferId}-${i}`)
        }

        transaction.oncomplete = () => resolve()
        transaction.onerror = (e) => e.target.error
    })
}

function connect(){
    ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
        retries = 0
        //document.getElementById('status').textContent = 'Connected :)'
        setStatus("connected", "Connected")

        console.log('[WS] connected')
    }

    ws.onmessage = (event) => {
        if(event.data instanceof ArrayBuffer){
            handleBinaryChunk(event.data)
            return 
        }
        //text frame
        let msg
        try {
            msg = JSON.parse(event.data)
        } catch (err) {
            console.error("[WS] invalid JSON received", err)
            return
        }

        console.log(`[WS MSG] type=${msg.type}`);
        routeMessage(msg)
    }

    ws.onclose = () => {
        setStatus("reconnecting", "Reconnecting...");
        const delay = Math.min(retries * 1000, 10000);
        console.log(`[WS] closed — retry in ${delay}ms`);
        setTimeout(connect, delay);
        retries++;
    }

    ws.onerror = (err) => {
        console.log('[WS] Error', err)
    }
}


function routeMessage(msg){
    switch (msg.type) {
        case "room-snapshot":
            handleRoomSnapshot(msg) 
            break
        case "presence": 
            handlePresence(msg)
            break
        case "pong-check":
            handlePongCheck(msg)
            break
        case "clipboard":
            handleClipboard(msg)
            break
        case "file-meta":
            handleFileMeta(msg)
            break
        case "file-eof":
            handleFileEof(msg)
            break

        default:
            console.warn(`[WS] unknown message type: ${msg.type}`)
    }
}

function handleRoomSnapshot(msg){
    myDeviceId = msg.yourDeviceId

    devices.clear()
    //console.log(msg)
    msg.members.forEach((member) => {
        devices.set(member.deviceId, member)
    })

    renderPresencePanel()

    console.log(`[SNAPSHOT] room has ${devices.size} device(s), I am ${myDeviceId}`)
}

function handlePresence(msg){
    if(msg.action === 'join'){
        devices.set(msg.deviceId, {
            deviceId: msg.deviceId,
            deviceType: msg.deviceType
        })
        console.log(`[PRESENCE] ${msg.deviceId} joined`)
    }

    if(msg.action === 'leave') {
        devices.delete(msg.deviceId)
        console.log(`[PRESENCE] ${msg.deviceId} left`)

        if(clipboardTargets !== 'all' && clipboardTargets instanceof Set){
            clipboardTargets.delete(msg.deviceId)
            if (clipboardTargets.size === 0) clipboardTargets = 'all'
        }
    }

    renderPresencePanel()
}

function handlePongCheck() {
    console.log('[WS] pong-check received — connection healthy')
}

function handleClipboard(msg) { 
    const textBox = document.getElementById('clipboard-input')
    if(!textBox) return
    textBox.value = msg.data
    showClipBoardStatus('received')

    console.log(`[CLIPBOARD] received from=${msg.fromDevice} chars=${msg.data.length}`)

}

function sendClipboard() {
    const textBox = document.getElementById('clipboard-input')
    if(!textBox) return
    
    const to = clipboardTargets === 'all'? 'all': [...clipboardTargets]
    sendJSON({
        type: 'clipboard',
        to,
        data: textBox.value
    })

    showClipBoardStatus('sent')
}

let statusTimer = null

function showClipBoardStatus(direction) {
    const el = document.getElementById('clipboard-status')
    if(!el) return

    clearTimeout(statusTimer)

    if(direction === 'sent') {
        const count = clipboardTargets === 'all'? devices.size - 1: clipboardTargets.size
        el.textContent = count > 0
            ? `↑ Synced to ${count} device${count !== 1 ? 's' : ''}`
            : '↑ No other devices in room'
        el.className = 'sync-status sent'
    } else {
        el.textContent = '↓ Updated from another device'
        el.className = 'sync-status received'
    }

    statusTimer = setTimeout(() => {
        el.textContent = ''
        el.className = 'sync status'
    }, 2000)
}

async function handleFileMeta(msg){
    if(activeReceive) {
        console.warn(`[FILE META] replacing in-progress transfer "${activeReceive.fileName}"`)
        activeReceive = null 
    }
    //console.log('hi')
    try{
        await openDB()
    }catch(err){
        console.error('[FILE META] cannot open IndexedDB — cannot receive files', err)
        showReceiveError('Storage unavailable — cannot receive files')
        return
    }

    let resolveAllWritesDone
    const allWritesDone = () => {
        return new Promise((resolve)=> {
            resolveAllWritesDone = resolve
        })
    }

    activeReceive = {
        transferId: msg.transferId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        totalChunks: msg.totalChunks,
        from: msg.from,
        nextChunkIndex: 0,
        chunksReceived: 0,
        pendingWrites: 0,
        eofReceived: false,
        resolveAllWritesDone,
        allWritesDone
    }

    showReceiveProgress(msg.fileName, 0, msg.totalChunks)
    console.log(`[FILE META] receiving "${msg.fileName}" ${(msg.fileSize/1024/1024).toFixed(1)}MB chunks=${msg.totalChunks} from=${msg.from}`)
}

function handleBinaryChunk(buffer){
    if(!activeReceive){
        console.warn('[BINARY] unexpected chunk — no active receive transfer')
        return
    }

    const state = activeReceive

    const index = state.nextChunkIndex++
    state.pendingWrites++
    writeChunk(state.transferId, index, buffer)
    .then(() => {
        state.chunksReceived++
        state.pendingWrites--

        showReceiveProgress(state.fileName, state.chunksReceived, state.totalChunks)
        
        if(state.eofReceived === true && state.pendingWrites === 0){
            state.resolveAllWritesDone()
        }
    })
    .catch((err) => {
            console.error(`[BINARY] IDB write failed for chunk ${index}`, err)
        state.pendingWrites--
    })
}

async function handleFileEof(msg){
    if(!activeReceive){
        console.warn('[FILE EOF] received but no active receive transfer')
        return
    }

    const state = activeReceive
    state.eofReceived = true
    console.log(`[FILE EOF] all ${state.totalChunks} chunks sent — waiting for IDB writes (pending: ${state.pendingWrites})`)

    if(state.pendingWrites === 0){
        state.resolveAllWritesDone()
    }

    await state.allWritesDone

    showReceiveAssembling(state.fileName)
    console.log(`[FILE EOF] all IDB writes flushed — assembling "${state.fileName}"`)

    try{
        const chunks = await readAllChunks(state.transferId, state.totalChunks)
        const blob = new Blob(chunks)
        const url = URL.createObjectURL(blob)

        const a = document.createElement('a')
        a.href = url
        a.download = state.fileName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)

        URL.revokeObjectURL(url)
        
        console.log(`[FILE EOF] download triggered — "${state.fileName}" (${(blob.size/1024/1024).toFixed(1)} MB)`)
        showReceiveComplete(state.fileName)

        await deleteChunks(state.transferId, state.totalChunks)
        console.log(`[FILE EOF] IDB cleanup complete — transferId=${state.transferId}`)
    }catch(err){
        console.error('[FILE EOF] assembly or download failed', err)
        showReceiveError(`Failed to download "${state.fileName}" — ${err.message}`)
    }finally{
        if(activeReceive === state) {
            activeReceive = null
            setTimeout(resetReceiveProgress, 4000)
        }
    }
}

function showReceiveProgress(fileName, chunksReceived, totalChunks){
    const progress = document.getElementById('receive-progress')
    const fname    = document.getElementById('receive-filename')
    const percent  = document.getElementById('receive-percent')
    const fill     = document.getElementById('receive-bar-fill')
    if (!progress) return

        const pct = totalChunks > 0 ? Math.round((chunksReceived / totalChunks) * 100) : 0

    progress.classList.remove('hidden')
    fname.textContent   = `↓ ${fileName}`
    percent.textContent = `${pct}%`
    fill.style.width    = `${pct}%`
}

function showReceiveAssembling(fileName){
    const percent = document.getElementById('receive-percent')
    if (percent) percent.textContent = '⏳ Assembling...'
}

function showReceiveComplete(fileName){
    const percent = document.getElementById('receive-percent')
    const status  = document.getElementById('receive-status')
    if (percent) percent.textContent = '✓ Done'
    if (status)  status.textContent  = `${fileName} saved to Downloads`
}

function showReceiveError(msg){
    const percent = document.getElementById('receive-percent')
    const status  = document.getElementById('receive-status')
    if (percent) percent.textContent = '✗ Failed'
        if (status)  status.textContent  = msg
}

function resetReceiveProgress(){
    const progress = document.getElementById('receive-progress')
    const fill     = document.getElementById('receive-bar-fill')
    const status   = document.getElementById('receive-status')
    if (progress) progress.classList.add('hidden')
    if (fill)     fill.style.width    = '0%'
    if (status)   status.textContent  = ''
}

async function sendFile(file){
    if(isSending){
        showFileError('Already sending a File - Please wait.')
        return
    }

    if(file.size > MAX_FILE_SIZE) {
        showFileError('File too large - Not supported')
        return
    }

    const others = [...devices.values()].filter((d)=>d.deviceId !== myDeviceId)
    if(others.length === 0){
        showFileError('No other devices in room')
        return
    }
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const transferId = generateTransferId()
    const to = (clipboardTargets === 'all')? 'all': [...clipboardTargets]
    isSending = true

    try{
        sendJSON({
            type: 'file-meta',
            transferId,
            fileName: file.name,
            fileSize: file.size,
            totalChunks,
            to
        })

        console.log(`[FILE] sending "${file.name}" size=${file.size} chunks=${totalChunks} id=${transferId}`)

        for(let i = 0; i < totalChunks; i++){
            const offset = i * CHUNK_SIZE
            const buffer = await readChunkAsBuffer(file, offset, CHUNK_SIZE)

            if(!ws || ws.readyState !== WebSocket.OPEN){
                throw new Error('Connection lost during transfer') 
            }

            ws.send(buffer)

            showSendProgress(file.name, i + 1, totalChunks)
        }

        sendJSON({
            type: 'file-eof',
            transferId
        })

        console.log(`[FILE] done "${file.name}"`)
        showSendComplete(file.name)
    }catch(err){
        console.error('[FILE] send error', err)
        showFileError(`Transfer failed — ${err.message}`)
        resetSendProgress()
    }finally{
        isSending = false
    }
}

function showSendProgress(fileName, sent, total){
    const progress = document.getElementById('transfer-progress')
    const fname    = document.getElementById('progress-filename')
    const percent  = document.getElementById('progress-percent')
    const fill     = document.getElementById('progress-bar-fill')
    if (!progress) return

    const pct = Math.round((sent / total) * 100)

    progress.classList.remove('hidden')
    fname.textContent   = fileName
    percent.textContent = `${pct}%`
    fill.style.width    = `${pct}%`
}

function showSendComplete(fname){
    const percent = document.getElementById('progress-percent')
    const fill    = document.getElementById('progress-bar-fill')
    if (percent) percent.textContent = '✓ Sent'
    if (fill)    fill.style.width    = '100%'
    setTimeout(resetSendProgress, 3000)
}

function resetSendProgress(){
    const progress = document.getElementById('transfer-progress')
    const fill     = document.getElementById('progress-bar-fill')
    if (progress) progress.classList.add('hidden')
    if (fill)     fill.style.width = '0%'
}

function toggleTarget(deviceId){
    if(clipboardTargets === 'all'){
        clipboardTargets = new Set([deviceId])
    } else {
        if(clipboardTargets.has(deviceId)){
            clipboardTargets.delete(deviceId)
            if(clipboardTargets.size === 0) clipboardTargets = 'all'
        } else {
            clipboardTargets.add(deviceId)
        }
    }

    renderPresencePanel()
}

function updateSendingStatus(){
    const el = document.getElementById('sending-status')
    if(!el) return 

    const others = [...devices.values()].filter((device)=> device.deviceId != myDeviceId)

    if(others.size === 0){
        el.textContent = 'No other devices in room'
        return
    }
    if (clipboardTargets === 'all') {
        el.textContent = 'Sending to everyone — click a device to target only them'
    } else {
        const count = clipboardTargets.size
        el.textContent = `Sending to ${count} device${count !== 1 ? 's' : ''} — click again to deselect`
    }
}

function setupDropZone(){
    const dropZone  = document.getElementById('drop-zone')
    const fileInput = document.getElementById('file-input')
    if (!dropZone || !fileInput) return

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0]
        if (file) sendFile(file)

        fileInput.value = ''
    })

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault()
        dropZone.classList.add('drag-over')
    })

    dropZone.addEventListener('dragleave', (e) => {
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove('drag-over')
        }
    })

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault() 
        dropZone.classList.remove('drag-over')
        const file = e.dataTransfer.files[0]
        if (file) sendFile(file)
    })

}

function renderPresencePanel(){
    const list = document.getElementById('device-list')

    list.innerHTML = ''
    if(devices.size === 0){
        updateSendingStatus()
        list.innerHTML = `<p class="empty-room">No devices in room yet</p>`
        return 
    }

    devices.forEach((device) => {
        const isYou = device.deviceId === myDeviceId
        const icon = device.deviceType === "mobile" ? "📱" : "💻"
        const label =  deviceLabel(device.deviceId)

        const isSelected = !isYou &&
                            clipboardTargets !== 'all' &&
                            clipboardTargets instanceof Set &&
                            clipboardTargets.has(device.deviceId)

        const card = document.createElement('div')
        card.className = [
            'device-card',
            isYou ? 'you': '',
            isSelected? 'selected': ''
        ].filter(Boolean).join(' ')
        card.dataset.deviceId = device.deviceId

        card.innerHTML = `
            ${isYou ? `<span class="you-badge">You</span>` : ""}
            <span class="device-icon">${icon}</span>
            <span class="device-label">${label}</span>
        `
        
        if(!isYou){
            card.addEventListener('click', () => toggleTarget(device.deviceId))
        }
        list.appendChild(card)
    })

    updateSendingStatus()
}

function setStatus(state, text){
    const el = document.getElementById('status')
    el.className = `status ${state}`
    el.textContent = text
    //renderPresencePanel()
}

function sendJSON(payload){
    if(!ws || ws.readyState !== WebSocket.OPEN){
        console.warn("[WS] tried to send but socket not open")
        return 
    }
    console.log(payload)
    ws.send(JSON.stringify(payload))
}   

const clipboardInput = document.getElementById('clipboard-input')
clipboardInput.addEventListener('input', debounce(sendClipboard, 100))
setupDropZone()
connect()