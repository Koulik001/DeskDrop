// Map<roomKey, Map<deviceId, websocket>>
const rooms = new Map()

function addToRoom(roomKey, deviceId, ws){
    if(!rooms.has(roomKey)){
        rooms.set(roomKey, new Map())
        console.log(`[ROOM CREATED] ${roomKey}`)
    }

    rooms.get(roomKey).set(deviceId, ws)
}

function removeDevice(roomKey, deviceId){
    if(!rooms.has(roomKey)) return
    const room = rooms.get(roomKey)
    room.delete(deviceId)
    console.log(`[ROOM]  ${roomKey} → ${room.size} member(s) remaining`)
    if(room.size === 0){
        rooms.delete(roomKey)
        console.log(`[ROOM DELETED] ${roomKey} — was empty`)
    }
}

function getRoom(roomKey){
    if(!rooms.has(roomKey)) return new Map()
    
    return rooms.get(roomKey)
}

function getRoomMembers(roomKey){
    const room = getRoom(roomKey)

    const members = []
    room.forEach((ws, deviceId) => {
        members.push({
            deviceId,
            deviceType: ws.meta?.deviceType || 'desktop'
        })
    })

    return members
}

function broadCastToRoom(roomKey, senderDeviceId, message){
    const room = getRoom(roomKey)

    const payload = JSON.stringify(message)

    room.forEach((ws, deviceId) => {
        if(deviceId === senderDeviceId) return

        if(ws.readyState !== 1) return

        ws.send(payload)
    })
}

function sendToDevices(roomKey, targetIds, message){
    const room = getRoom(roomKey)
    const payload = JSON.stringify(message)
    targetIds.forEach((deviceId) => {
        const ws = room.get(deviceId)
        if(!ws) return

        if(ws.readyState !== 1) return

        ws.send(payload)
    })
}

//Binary forwarding for files
function broadCastBinaryToRoom(roomKey, senderDeviceId, buffer) {
    const room = getRoom(roomKey)

    room.forEach((ws, deviceId) => {
        if(deviceId === senderDeviceId) return
        if(ws.readyState !== 1) return 
        ws.send(buffer)
    })
}

function sendBinaryToDevices(roomKey, targetIds, buffer){
    const room = getRoom(roomKey)

    targetIds.forEach((deviceId) => {
        const ws = room.get(deviceId)
        if(!ws || ws.readyState !== 1) return 

        ws.send(buffer)
    })
}


module.exports = { addToRoom, getRoom, removeDevice, getRoomMembers, broadCastToRoom, sendToDevices, broadCastBinaryToRoom, sendBinaryToDevices }

