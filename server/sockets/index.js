// A player connection: connection data shared by all handlers, and handler registration
const { io } = require('../app');
const registerRoomHandlers = require('./room');
const registerRoleHandlers = require('./roles');
const registerHostHandlers = require('./host');
const registerTrashHandlers = require('./trash');
const registerP2pHandlers = require('./p2p');
const registerEditorHandlers = require('./editor');
const registerFeatureHandlers = require('./features');

io.on('connection', socket => {
  // Changed on joining a room and on renaming; handlers read them at call time
  const conn = { roomId: null, nick: '', clientId: '' };
  registerRoomHandlers(socket, conn);
  registerRoleHandlers(socket, conn);
  registerHostHandlers(socket, conn);
  registerTrashHandlers(socket, conn);
  registerP2pHandlers(socket, conn);
  registerEditorHandlers(socket, conn);
  registerFeatureHandlers(socket, conn);
});
