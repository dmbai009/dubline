// A player connection: connection data shared by all handlers, and handler registration
const { io } = require('../app');
const registerRoomHandlers = require('./room');
const registerRoleHandlers = require('./roles');
const registerHostHandlers = require('./host');
const registerTrashHandlers = require('./trash');
const registerP2pHandlers = require('./p2p');
const registerEditorHandlers = require('./editor');
const registerFeatureHandlers = require('./features');
const registerProjectAudio = require('./project-audio');

io.on('connection', socket => {
  // Changed on joining a room and on renaming; handlers read them at call time
  const conn = { roomId: null, nick: '', clientId: '' };
  require('../sessionScope').register(socket, conn);
  registerRoomHandlers(socket, conn);
  require('../moderators').register(socket, conn);
  registerRoleHandlers(socket, conn);
  registerHostHandlers(socket, conn);
  registerTrashHandlers(socket, conn);
  registerP2pHandlers(socket, conn);
  registerEditorHandlers(socket, conn);
  require('../editorOperations').registerRecovery(socket, conn);
  registerFeatureHandlers(socket, conn);
  registerProjectAudio(socket, conn);
  require('../selectionPresence').register(socket, conn);
  require('../editLeases').register(socket, conn);
  require('../mediaPresence').register(socket, conn);
  require('../snapshotBarrier').register(socket, conn);
  require('../cursorPresence').register(socket, conn);
});
