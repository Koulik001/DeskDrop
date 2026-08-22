require('dotenv').config();
const express = require('express')
const expressWs = require('express-ws')
const { v4: uuidv4 } = require('uuid')
const { addToRoom, getRoom, removeDevice, getRoomMembers, broadCastToRoom, sendToDevices } = require('./roomManager')
const { handleMsg, handleDeviceJoined , handleDeviceLeft, handleBinaryChunk } = require('./messageHandler')
const path = require('path')


const app = express()
const wsInstance = expressWs(app)
const wss = wsInstance.getWss()
app.set("trust proxy", 1)

app.use(express.static(path.join(__dirname, '../public')))

function extractroomKey(req){
    const raw = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1'
    //console.log(raw)
    if(raw.startsWith('::ffff')){
        const ip = raw.replace('::ffff', '')
        return classifyIPv4(ip)
    }
    
    if(raw.includes(':')){
        return classifyIPv6(raw)
    }
    

    return classifyIPv4(raw)
}

function classifyIPv4(ip){
    const parts = ip.split('.')
    if (parts.length !== 4) return "subnet:local";

    const first = parseInt(parts[0])
    const second = parseInt(parts[1])

    const isPrivate = 
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)

    if(isPrivate){
        return `subnet:${parts.slice(0, 3).join('.')}`
    }

    return `subnet:${ip}`
}

function classifyIPv6(ip){
    const expanded = expandIPv6(ip)

    const groups = expanded.split(':')

    if(groups.length < 4) return 'subnet:local'

    const prefix64bit = groups.slice(0, 4).join(':')
    return `subnet:${prefix64bit}`
}

app.ws("/ws", (ws, req) => {
    //console.log('hii')
    //console.log(ws);
    const deviceId = uuidv4()
    //console.log(deviceId)
    const roomKey = extractroomKey(req)
    const deviceType = req.query.deviceType || 'desktop'
    
    ws.meta = {deviceId, roomKey, deviceType, isAlive: true}
    
    addToRoom(roomKey, deviceId, ws)

    console.log(`[CONNECT] device = ${deviceId} to ${roomKey}, type = ${deviceType}`)
    console.log(`[ROOM ${roomKey}] members = ${getRoomMembers(roomKey).length}`)
    handleDeviceJoined(ws)
    ws.on('pong', ()=>{
        ws.meta.isAlive = true;
    })

    ws.on('message', (data, isBinary)=>{
        if(isBinary === true || (isBinary === undefined && Buffer.isBuffer(data))){
            handleBinaryChunk(ws, data)
            return
        }

        handleMsg(ws, data)
    })

    ws.on('close', ()=>{
        removeDevice(roomKey, deviceId)
        handleDeviceLeft(roomKey, deviceId)
        console.log(`[DISCONNECT] device = ${deviceId} room = ${roomKey}`)
        console.log(`[ROOM ${roomKey}] members=${getRoomMembers(roomKey).length}`)
    })

    ws.on('error', (err)=>{
        console.error(`[ERROR] device = ${deviceId}`, err.message)
    })
})

function expandIPv6(ip){
    if(!ip.includes('::')) return ip

    const sides = ip.split('::')
    const left = sides[0]? sides[0].split(':'): []
    const right = sides[1]? sides[1].split(':'): []

    const missing0s = 8 - left.length - right.length

    const zeros = Array(missing0s).fill(0)

    return [...left, ...zeros, ...right].join(':')
}

const PING_INTERVAL = 15000
//let cnt = 0
const heartbeat = setInterval(()=>{
    wss.clients.forEach(ws => {
        if(!ws.meta) return
        // console.log('hi', cnt)
        // cnt++
        if(!ws.meta.isAlive){
            console.log(`[ZOMBIE] terminating device=${ws.meta.deviceId}`)
            removeDevice(ws.meta.roomKey, ws.meta.deviceId)
            handleDeviceLeft(ws.meta.roomKey, ws.meta.deviceId)
            ws.terminate()
            return
        }

        ws.meta.isAlive = false
        ws.ping()
    })

    
}, PING_INTERVAL)

const PORT = process.env.PORT || 3000

const server = app.listen(PORT, ()=>{
    console.log(`DeskDrop running on http://localhost:${PORT}`)
})

server.on('close', ()=>{
    clearInterval(heartbeat)
    console.log("[SHUTDOWN] heartbeat cleared")
})

