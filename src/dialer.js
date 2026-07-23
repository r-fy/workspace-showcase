// Twilio Voice JS SDK, bundled the same way as the editor (esbuild in the
// Dockerfile). app.js reaches it via window.TwilioVoice.
import { Device } from '@twilio/voice-sdk';

window.TwilioVoice = { Device };
