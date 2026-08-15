// Desktop app voice backend (main process) — thin re-export. The actual
// STT/TTS implementation lives in src/voiceIO.js so it can be shared with
// the Discord daemon (src/discord/voice/session.js) without duplication.
module.exports = require('../src/voiceIO');
