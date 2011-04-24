var extend = require('./utils').extend;
var ctio = require('../vendor/node-ctype/ctio');

const DECODE_HEADER = 1;
const WAITING_FOR_16_BIT_LENGTH = 2;
const WAITING_FOR_64_BIT_LENGTH = 3;
const WAITING_FOR_MASK_KEY = 4;
const WAITING_FOR_PAYLOAD = 5;
const COMPLETE = 6;

// WebSocketConnection will pass shared buffer objects for maskBytes and
// frameHeader into the constructor to avoid tons of small memory allocations
// for each frame we have to parse.  This is only used for parsing frames
// we receive off the wire.
function WebSocketFrame(maskBytes, frameHeader, config) {
    this.maskBytes = maskBytes;
    this.frameHeader = frameHeader;
    this.config = config;
    this.maxReceivedFrameSize = config.maxReceivedFrameSize;
    this.protocolError = false;
    this.frameTooLarge = false;
    this.parseState = DECODE_HEADER;
};

extend(WebSocketFrame.prototype, {
    addData: function(bufferList, fragmentationType) {
        var temp;
        // if (this.parseState === LOAD_MASK_KEY) {
        //     if (bufferList.length >= 4) {
        //         bufferList.joinInto(this.maskBytes, 0, 0, 4);
        //         bufferList.advance(4);
        //         this.maskPos = 0;
        //         this.parseState = DECODE_HEADER;
        //     }
        // }
        if (this.parseState === DECODE_HEADER) {
            if (bufferList.length >= 2) {
                bufferList.joinInto(this.frameHeader, 0, 0, 2);
                bufferList.advance(2);
                var firstByte = this.frameHeader[0];
                var secondByte = this.frameHeader[1];

                this.fin     = Boolean(firstByte  & 0x80);
                this.rsv1    = Boolean(firstByte  & 0x40);
                this.rsv2    = Boolean(firstByte  & 0x20);
                this.rsv3    = Boolean(firstByte  & 0x10);
                this.mask    = Boolean(secondByte & 0x80);

                this.opcode  = firstByte  & 0x0F;
                this.length = secondByte & 0x7F;
                
                if (this.length === 126) {
                    this.parseState = WAITING_FOR_16_BIT_LENGTH;
                }
                else if (this.length === 127) {
                    this.parseState = WAITING_FOR_64_BIT_LENGTH;
                }
                else {
                    this.parseState = WAITING_FOR_MASK_KEY;
                }
            }
        }
        if (this.parseState === WAITING_FOR_16_BIT_LENGTH) {
            if (bufferList.length >= 2) {
                bufferList.joinInto(this.frameHeader, 2, 0, 2);
                bufferList.advance(2);
                this.length = ctio.ruint16(this.frameHeader, 'big', 2);
                this.parseState = WAITING_FOR_MASK_KEY;
            }
        }
        else if (this.parseState === WAITING_FOR_64_BIT_LENGTH) {
            if (bufferList.length >= 8) {
                bufferList.joinInto(this.frameHeader, 2, 0, 8);
                bufferList.advance(8);
                var lengthPair = ctio.ruint64(this.frameHeader, 'big', 2);
                if (lengthPair[0] !== 0) {
                    this.protocolError = true;
                    this.dropReason = "Unsupported 64-bit length frame received";
                    return true;
                }
                this.length = lengthPair[1];
                this.parseState = WAITING_FOR_MASK_KEY;
            }
        }
        
        if (this.parseState === WAITING_FOR_MASK_KEY) {
            if (this.mask) {
                if (bufferList.length >= 4) {
                    bufferList.joinInto(this.maskBytes, 0, 0, 4);
                    bufferList.advance(4);
                    this.maskPos = 0;
                    this.parseState = WAITING_FOR_PAYLOAD;
                }
            }
            else {
                this.parseState = WAITING_FOR_PAYLOAD;
            }
        }
        
        if (this.parseState === WAITING_FOR_PAYLOAD) {
            if (this.length > this.maxReceivedFrameSize) {
                this.frameTooLarge = true;
                this.dropReason = "Frame size of " + this.length.toString(10) +
                                  " bytes exceeds maximum accepted frame size";
                return true;
            }
            
            if (this.opcode === 0x00 && fragmentationType === 0x00) {
                // Unhandled continuation frame
                this.protocolError = true;
                this.dropReason = "Received unexpected continuation frame.";
                return true;
            }
            else {
                if (this.length === 0) {
                    this.binaryPayload = new Buffer(0);
                    this.parseState = COMPLETE;
                    return true;
                }
                if (bufferList.length >= this.length) {
                    this.binaryPayload = bufferList.take(this.length);
                    bufferList.advance(this.length);
                    if (this.mask) {
                        this.applyMask(this.binaryPayload, 0, this.length);
                    }
                    
                    if (this.opcode === 0x08) { // WebSocketOpcode.CONNECTION_CLOSE
                        this.closeStatus = ctio.ruint16(this.binaryPayload, 'big', 0);
                        this.binaryPayload = this.binaryPayload.slice(2);
                    }
                    
                    this.parseState = COMPLETE;
                    return true;
                }
            }
        }
        return false;
    },
    throwAwayPayload: function(bufferList) {
        if (bufferList.length >= this.length) {
            bufferList.advance(this.length);
            this.parseState = COMPLETE;
            return true;
        }
        return false;
    },
    applyMask: function(buffer, offset, length) {
        var end = offset + length;
        for (var i=offset; i < end; i++) {
            buffer[i] = buffer[i] ^ this.maskBytes[this.maskPos];
            this.maskPos = (this.maskPos + 1) & 3;
        }
    },
    toBuffer: function(nullMask) {
        var maskKey;
        var headerLength = 2;
        var data;
        var outputPos;
        var firstByte = 0x00;
        var secondByte = 0x00;
        
        if (this.fin) {
            firstByte |= 0x80;
        }
        if (this.rsv1) {
            firstByte |= 0x40;
        }
        if (this.rsv2) {
            firstByte |= 0x20;
        }
        if (this.rsv3) {
            firstByte |= 0x10;
        }
        if (this.mask) {
            secondByte |= 0x80;
        }

        firstByte |= (this.opcode & 0x0F);

        // the close frame is a special case because the close reason is
        // prepended to the payload data.
        if (this.opcode === 0x08) {
            this.length = 2;
            if (this.binaryPayload) {
                this.length += this.binaryPayload.length;
            }
            data = new Buffer(this.length);
            ctio.wuint16(this.closeStatus, 'big', data, 0);
            if (this.length > 2) {
                this.binaryPayload.copy(data, 2);
            }
        }
        else if (this.binaryPayload) {
            data = this.binaryPayload;
            this.length = data.length;
        }
        else {
            this.length = 0;
        }

        if (this.length <= 125) {
            // encode the length directly into the two-byte frame header
            secondByte |= (this.length & 0x7F);
        }
        else if (this.length > 125 && this.length <= 0xFFFF) {
            // Use 16-bit length
            secondByte |= 126;
            headerLength += 2;
        }
        else if (this.length > 0xFFFF) {
            // Use 64-bit length
            secondByte |= 127;
            headerLength += 8;
        }

        output = new Buffer(this.length + headerLength + (this.mask ? 4 : 0));

        // write the frame header
        output[0] = firstByte;
        output[1] = secondByte;

        outputPos = 2;

        if (this.length > 125 && this.length <= 0xFFFF) {
            // write 16-bit length
            ctio.wuint16(this.length, 'big', output, outputPos);
            outputPos += 2;
        }
        else if (this.length > 0xFFFF) {
            // write 64-bit length
            ctio.wuint64([0x00000000, this.length], 'big', output, outputPos);
            outputPos += 8;
        }
        
        if (this.length > 0) {
            data.copy(output, outputPos);
            
            if (this.mask) {
                if (!nullMask) {
                    // Generate a mask key
                    maskKey = parseInt(Math.random()*0xFFFFFFFF);
                }
                else {
                    maskKey = 0x00000000;
                }
                ctio.wuint32(maskKey, this.maskBytes, 'big', 0);
                this.maskPos = 0;

                // write the mask key
                this.maskBytes.copy(output, 0, 0, 4);
                outputPos += 4;
            
                this.applyMask(output, 0, outputPos, data.length);
            }
        }

        return output;
    }
});


module.exports = WebSocketFrame;