const fs = require('fs');

const mineflayer = require("mineflayer");

const { AbortController } = require('abort-controller');
const ObservationUtils = require("./observation_utils");
const ViewerManager = require("./viewer_manager");
const pvp = require("mineflayer-pvp").plugin;
const tool = require("mineflayer-tool").plugin;
const minecraftHawkEye = require("minecrafthawkeye");
const {
    Movements,
    goals: {
        Goal, GoalBlock, GoalNear, GoalXZ, GoalNearXZ, GoalY, GoalGetToBlock, GoalLookAtBlock,
        GoalBreakBlock, GoalCompositeAny, GoalCompositeAll, GoalInvert, GoalFollow, GoalPlaceBlock,
    },
    pathfinder,
    Move, ComputedPath, PartiallyComputedPath, ZCoordinates,
    XYZCoordinates, SafeBlock, GoalPlaceBlockOptions,
} = require("mineflayer-pathfinder");
const { Vec3 } = require('vec3');
const collectBlock = require("mineflayer-collectblock-colalab").plugin;

// basic functions that ai can use
let filePathPrefix = '../../assets/high_level_action/'
let filePathsRaw = ['craftHelper.js', 'craftItem.js', 'givePlacedItemBack.js', 'killMob.js', 'mineBlock.js','placeItem.js', 'shoot.js', 'smeltItem.js', 'useChest.js', 'waitForMobRemoved.js']
let filePaths = filePathsRaw.map((filePath) => filePathPrefix + filePath)

class BotManager {

constructor() {
    this.bots = [];
    this.events = []; // all events during one step
    this.code_status = []
    this.code_error = []
    this.code_tick = []
    this.abort_controllers = []
    this.current_code = []
    this.viewer_manager = new ViewerManager()
    this.tp_interval = null // tp_interval is used to stop bots'movements when pausing.
    this.bots_positions = []
    this.mineflayer_timeout_interval = 1000000 // 600s
    this.mineflayer_view_distance = 'normal' // far/normal/short/tiny, refer to https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md#botsettingsviewdistance

    this.hearing_distance = 50.0
    this.high_level_action_code = ""

    this.tick = 0
}

createBot = (username, host, port, version) => {
    const self = this;

    const bot = mineflayer.createBot({
        host: host,
        port: port,
        username: username,
        version: version,
        checkTimeoutInterval: self.mineflayer_timeout_interval,
        viewDistance: self.mineflayer_view_distance,
    });
    
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(pvp);
    bot.loadPlugin(tool);
    bot.loadPlugin(minecraftHawkEye)
    this.bots.push(bot);
    this.code_status.push('ready')
    this.abort_controllers.push(new AbortController())
    this.code_error.push('')
    this.current_code.push('')
    this.events.push([])
    this.code_tick.push(0)
    bot.on('spawn', () => {
        self.bots_positions.push(bot.entity.position);
    })
    this.addEventListener(bot);
    this.high_level_action_code = this.loadHighLevelActionCode()

    // track the tick
    if (this.bots.length === 1) {
        bot.on('physicsTick', () => {
            this.tick += 1
        })
    }
}
/**
 * load high level action
 * @param {mineflayer.Bot} bot
 */
loadHighLevelActionCode = () => {
    var high_level_action_code = ""
    for(var i = 0; i < filePaths.length; ++i) {
        const path = filePaths[i]
        const fileContent = fs.readFileSync(path, 'utf-8');
        high_level_action_code += fileContent
    }
    return high_level_action_code
}

/**
 * Add event listener to a bot
 * @param {mineflayer.Bot} bot
 */
addEventListener = (bot, is_first_bot=false) => {
    //TODO: add more event listeners
    const self = this;
    
    // on bot get hurt
    bot.on('entityHurt', (entity) => {
        if (entity === bot.entity) {
            this.events[this.bots.indexOf(bot)].push({
                type: 'entityHurt',
                entity_name: 'bot',
                message: 'bot#' + bot.username + ' get hurt',
                tick: self.tick,
            })
        } else if (entity.name === 'zombie') {
            this.events[this.bots.indexOf(bot)].push({
                type: 'entityHurt',
                entity_name: 'zombie',
                message: 'A zombie is hurt',
                tick: self.tick,
            })
        }
    });

    // on arbitrary entity dead
    bot.on('entityDead', (entity) => {
        if(this.calc_dis(entity.position, bot.entity.position) < this.hearing_distance) {
            this.events[this.bots.indexOf(bot)].push({
                type: 'entityDead',
                entity_name: entity.name,
                message: entity.name + ' dead',
                tick: self.tick,
            })
        }
    })
    
    // eat something
    bot.on('entityEat', (entity) => {
        if(this.calc_dis(entity.position, bot.entity.position) < this.hearing_distance) {
            this.events[this.bots.indexOf(bot)].push({
                type: 'entityEat',
                entity_name: entity_name,
                tick: self.tick,
            })
        }
        
    })

    // on get chat message
    bot.on('chat', (username, message) => {
        if (username === 'Server') return;
        if (message.startsWith('commands.pause')) return;
        if (message.startsWith('/')) return;
        if (message.startsWith('Teleported')) return;

        const sending_bot = this.getBotByName(username)
        if(sending_bot) {
            if(this.calc_dis(bot.entity.position, sending_bot.entity.position) < this.hearing_distance) {
                this.events[this.bots.indexOf(bot)].push({
                    type: 'chat',
                    only_message : message,
                    username : username,
                    message: "<" + username + '> ' + message,
                    tick: self.tick,
                })
            }
        }
        else {
                this.events[this.bots.indexOf(bot)].push({
                    type: 'chat',
                    only_message : message,
                    username : username,
                    message: "<" + username + '> ' + message,
                    tick: self.tick,
                })
        }
        // console.log("check finish!")
    });

    bot.on('death', () => {
        this.events[this.bots.indexOf(bot)].push({
            type: 'death',
            message: 'bot#' + bot.username + ' dead',
            tick: self.tick,
        })
        
        // console.log('bot#' + bot.username + ' dead')
    }); 

    bot.on('blockBreakProgressEnd', (block, entity) => {
        this.events[this.bots.indexOf(bot)].push({
            type: 'blockIsBeingBroken',
            block_name: block.name,
            message: 'A ' + block.name + ' block is being broken',
            tick: self.tick,
        })
    })
}



calc_dis = (pos1, pos2)=>{
    return Math.sqrt((pos1.x-pos2.x) * (pos1.x-pos2.x) + (pos1.y-pos2.y) * (pos1.y-pos2.y) + (pos1.z-pos2.z) * (pos1.z-pos2.z))
}

updateBotsPositions = () => {
    for(let i = 0; i < this.bots.length; ++i) {
        this.bots_positions[i] = this.bots[i].entity.position;
    }
}

startTpInterval = () => {
    // const self = this;
    // this.tp_interval = setInterval(() => {
    //     //tp bots to themselves
    //     for(let i = 0; i < self.bots.length; ++i) {
    //         self.bots[i].chat('/tp ' + self.bots[i].username + ' ' + self.bots_positions[i].x+ ' ' + self.bots_positions[i].y+ ' ' + self.bots_positions[i].z);
    //     }
    // }, 5)
}
changeCodeTick = (id, tick) => {
    this.code_tick[id] = tick
}
addCodeTick = (id, tick) =>{
    this.code_tick[id] += tick
}
stopTpInterval = () => {
    if(this.tp_interval) {
        clearInterval(this.tp_interval);
        this.tp_interval = null;
    }
}

stopAll = () => {
    this.bots.forEach(bot=> {
        bot.end();
    });
    this.bots = [];
    this.code_status = [];
}


interruptBotByOrder = (id) => {
    let bot = this.bots[id];
    if(this.abort_controllers[id]) {
        this.abort_controllers[id].abort();
    }
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.stopDigging();
    this.code_status[id] = 'ready'
}
runCodeByOrder = async (id, code) => {
    this.abort_controllers[id]=new AbortController()
    const self = this;
    self.code_status[id] = 'running';
    /**
     * @type {mineflayer.Bot}
     */
    let bot = self.bots[id];
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    self.abort_controllers[id].signal.addEventListener( 'abort', () => { 
            bot=undefined 
        } 
    );
    
    try {
        let mineflayer_bot_id = id
        this.current_code[id] = code
        await eval("(async () =>{" +this.high_level_action_code+ "\n" + code +"\n"+"})()")
        self.code_status[mineflayer_bot_id] = 'ready'
    }
    catch(e) {
        console.log("catched after eval" , e);
        if(bot) {
            this.code_status[id] = 'ready';
            this.code_error[id] = e;
        }
    }

}

runCodeByName = async(name, code) => {
    for(let i = 0;i < this.bots.length; ++i) {
        if(this.bots[i].username == name) {
            runCodeByOrder(i, code);
            return;
        }
    }
}
clearCodeErorrs = () => {
    for(let i = 0; i < this.bots.length; ++i) {
        this.code_error[i] = ''
    }
}
getBotByName = (name) => {
    for(var i = 0; i < this.bots.length; i++){
        const bot = this.bots[i]
        if(bot.username == name) {
            return bot
        }
    }
    return null
}

getBotByOrder = (id) => {
    let len = this.bots.length;
    if(id >= len) {
        return this.bots[len - 1];
    }
    return this.bots[id];
}
getCodeStatus = () =>{
    return this.code_status;
}
getBotNumber = () => { 
    return this.bots.length;
}

/**
 * Get the observation space of a bot
 */
getBotObservation = (id) => {
    return ObservationUtils.getObservation(this.bots[id], this.viewer_manager, this.tick);
}

/**
 * Create viewer on all bots
 */
createViewerOnAllBots(width, height) {
    this.viewer_manager.createViewerOnAllBots(this.bots, width, height)
}

/**
 * Get the code execute error of a bot
 */
getCodeError = (id) => {
    let error = this.code_error[id];
    if(error==='') return {};

    return {
        error_type: error.name,
        error_message: error.message,
        error_stack: error.stack,
    }
}

/**
 * Get the code info of a bot
 */
getCodeInfo = (id) => {
    let name = this.bots[id].username;
    let is_running = this.code_status[id] === 'running';
    let is_ready = is_running ? false : true;
    let error = this.getCodeError(id);
    let last_code = this.current_code[id]
    let code_tick = this.code_tick[id]
    return {
        name: name,
        is_running: is_running,
        is_ready: is_ready,
        last_code: last_code,
        code_tick: code_tick,
        code_error: error,
    }
}

/**
 * Get the event of a bot
 */
getEvent = (id) => {
    if(id < this.events.length) return this.events[id]
    else return []
}

/**
 * Clear all events
 */
clearEvents = () => {
    for(let i = 0; i < this.bots.length; ++i) {
        this.events[i] = []
    }
}
allBotChat = (s) => {
    for(let i = 0; i < this.bots.length; ++i) {
        this.bots[i].chat(s)
    }
}

/* ===== Camera ===== */

/**
 * Create a camera
 */
addCamera = (camera_id, image_width, image_height) => {
    this.viewer_manager.addCamera(this.bots[0], camera_id, image_width, image_height)
}

/**
 * Get a screenshot of a camera in base64 format.
 */
getCameraView(camera_id) {
    return this.viewer_manager.getCameraView(camera_id)
}

/**
 * Modify the location of a camera
 */
modifyCameraLoc(camera_id, pos, yaw, pitch) {
    this.viewer_manager.modifyCameraLoc(camera_id, pos, yaw, pitch)
}

addCameraLoc(camera_id, d_pos, d_yaw, d_pitch) {
    this.viewer_manager.addCameraLoc(camera_id, d_pos, d_yaw, d_pitch)
}

moveCameraLoc(camera_id, d_pos, d_yaw, d_pitch) {
    this.viewer_manager.forwardCamera(camera_id, d_pos.x)
    this.viewer_manager.upCamera(camera_id, d_pos.y)
    this.viewer_manager.rightCamera(camera_id, d_pos.z)
    this.viewer_manager.addCameraLoc(camera_id, new Vec3(0, 0, 0), d_yaw, d_pitch)
}
/**
 * Modify the position of a camera
 */
modifyCameraPos(camera_id, pos) {
    this.viewer_manager.modifyCameraPos(camera_id, pos)
}

/**
 * Modify the compass of a camera
 */
modifyCameraCompass(camera_id, yaw, pitch) {
    this.viewer_manager.modifyCameraCompass(camera_id, yaw, pitch)
}

}

module.exports = BotManager;
