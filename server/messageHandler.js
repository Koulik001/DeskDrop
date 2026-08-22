const { addToRoom, getRoom, removeDevice, getRoomMembers, broadCastToRoom, sendToDevices, broadCastBinaryToRoom, sendBinaryToDevices } = require('./roomManager')

function handleMsg(ws, rawData) {
    let msg
    try {
        msg = JSON.parse(rawData)
    } catch(err) {
        console.error(`[MSG ERROR] invalid JSON from device=${ws.meta.deviceId}`, err.message)
        return
    }

    console.log(`[MSG IN] type=${msg.type} from=${ws.meta.deviceId}`)

    switch(msg.type) {
        case "ping-check":
            handlePingCheck(ws)
            break
        case "clipboard":
            handleClipBoard(ws, msg)
            break
        case "file-meta":
            handleFileMeta(ws, msg)
            break
        case "file-eof":
            handleFileEof(ws, msg)
            break

        default:
            console.warn(`[MSG WARN]  unknown type=${msg.type} from=${ws.meta.deviceId}`);
    }
}

function handlePingCheck(ws){
    if(ws.readyState !== 1) return 
    ws.send(JSON.stringify({type: "pong-check"}))
}

function handleClipBoard(ws, msg){
    // console.log(`[CLIPBOARD] stub — will implement Day 4`)
    const { deviceId, roomKey } = ws.meta

    if(typeof msg.data !== 'string'){
        console.warn(`[CLIPBOARD] invalid data field from device=${deviceId}`)
        return
    }

    const outgoing = {
        type: 'clipboard',
        fromDevice: deviceId,
        data: msg.data
    }

    if(msg.to === 'all'){
        broadCastToRoom(roomKey, deviceId, outgoing)
        console.log(`[CLIPBOARD] broadcast  from=${deviceId} chars=${msg.data.length}`)
    } else if(Array.isArray(msg.to) && msg.to.length > 0){
        sendToDevices(roomKey, msg.to, outgoing)
        console.log(`[CLIPBOARD] targeted   from=${deviceId} to=[${msg.to}] chars=${msg.data.length}`)
    } else {
        console.warn(`[CLIPBOARD] invalid 'to' field from device=${deviceId}`)
    }

    
}

function handleFileMeta(ws, msg){
    const { deviceId, roomKey } = ws.meta

    if(!msg.transferId || !msg.fileName || !msg.fileSize || !msg.totalChunks){
        console.warn(`[FILE META] missing required fields from device=${deviceId}`)
        return
    }

    const targetIds = Array.isArray(msg.to)? msg.to: null

    ws.meta.streamState = {
        transferId: msg.transferId,
        fileName: msg.fileName,
        totalChunks: msg.totalChunks,
        chunksReceived: 0,
        targetIds
    }

    const outgoing = {
        type: 'file-meta',
        transferId: msg.transferId,
        from: deviceId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        totalChunks: msg.totalChunks
    }

    if(targetIds === null){
        broadCastToRoom(roomKey, deviceId, outgoing)
    }else{
        sendToDevices(roomKey, targetIds, outgoing)
    }

    console.log(`[FILE META] from=${deviceId} file="${msg.fileName}" size=${msg.fileSize} chunks=${msg.totalChunks}`)
}

function handleBinaryChunk(ws, buffer){
    const { roomKey, deviceId } = ws.meta
    if(!ws.meta.streamState) {
        console.log(`[BINARY] unexpected chunk from device=${deviceId} — no active transfer`)
        return
    }

    const state = ws.meta.streamState
    state.chunksReceived++
    if(state.targetIds === null){
        broadCastBinaryToRoom(roomKey, deviceId, buffer)
    }else{
        sendBinaryToDevices(roomKey, state.targetIds, buffer)
    }

    if (state.chunksReceived % 10 === 0 || state.chunksReceived === state.totalChunks) {
        console.log(`[BINARY]   chunk ${state.chunksReceived}/${state.totalChunks} from=${deviceId} file="${state.fileName}"`)
    }
}

function handleFileEof(ws, msg){
    const { roomKey, deviceId } = ws.meta

    if(!ws.meta.streamState) {
        console.log(`[FILE EOF] no active transfer device=${deviceId}`)
        return
    }

    const { transferId, targetIds, chunksReceived, totalChunks, fileName } = ws.meta.streamState

    const outgoing = {
        type: 'file-eof',
        transferId,
        from: deviceId
    }

    if(targetIds === null){
        broadCastToRoom(roomKey, deviceId, outgoing)
    }else{
        sendToDevices(roomKey, targetIds, outgoing)
    }

    console.log(`[FILE EOF]  from=${deviceId} file="${fileName}" chunks=${chunksReceived}/${totalChunks}`)

    ws.meta.streamState = null
}


function handleDeviceJoined(ws){
    const {deviceId, roomKey, deviceType} = ws.meta

    const members = getRoomMembers(roomKey)

    const snapShot = {
        type: "room-snapshot",
        yourDeviceId: deviceId,
        members
    }

    if(ws.readyState === 1) {
        ws.send(JSON.stringify(snapShot))
    }

    console.log(`[SNAPSHOT] sent to device=${deviceId} — ${members.length} member(s) in room`)

    const joinMsg = {
        type: "presence",
        action: "join",
        deviceId,
        deviceType
    }

    broadCastToRoom(roomKey, deviceId, joinMsg)

    console.log(`[PRESENCE] join broadcast — device=${deviceId} type=${deviceType}`)
}

function handleDeviceLeft(roomKey, deviceId){
    const leaveMsg = {
        type: "presence",
        action: "leave",
        deviceId
    }

    broadCastToRoom(roomKey, deviceId, leaveMsg)
    console.log(`[PRESENCE] leave broadcast — device=${deviceId}`)
}

module.exports = {
    handleMsg, 
    handleDeviceJoined,
    handleDeviceLeft,
    handleBinaryChunk
}