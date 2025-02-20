import { NODE_ENV, WS_ACTIVITY_TIMEOUT_MS } from '../config';
import log from '../log';
import Player from '../models/player';
import { WsPayload } from '../payloads/incoming';
import { OutgoingMsgType } from '../payloads/outgoing';
import { validators } from '../payloads/jsonschema';
import WebSocket from 'ws';
import { MessageHandlerResponse } from './common';
import { HandlerNotFoundError, processSocketMessage } from './handlers';
import ValidationError from 'ajv/dist/runtime/validation_error';
import { stringifiers } from '../payloads/jsonschema';

/**
 * This class is used as a WebSocket wrapper to:
 *  - Safely send messages out a WebSocket
 *  - Gate the flow of incoming messages using a lock/mutex
 *  - Process incoming messages appropriately
 *  - Store metadata alongside the socket to link it with a player
 */
export default class PlayerSocketDataContainer {
  private locked = false;
  private sequence = 0;
  private lastRecvTs!: number;
  private kickTimer: NodeJS.Timeout;
  private player: Player | undefined;

  constructor(private ws: WebSocket) {
    this.kickTimer = setInterval(() => {
      // Check if this socket is still in active use. An active socket is one
      // that has received a message from a client in the past 5 minutes.
      // If a client has sent no payloads by the time the first interval is run
      // we also kick them since they should initialise a session immediately.
      const now = Date.now();
      if (
        this.lastRecvTs === undefined ||
        now - this.lastRecvTs > WS_ACTIVITY_TIMEOUT_MS
      ) {
        log.info(
          `kicking inactive socket for player ${
            this.player?.getUUID() || '*uninitialised*'
          }`
        );
        this.close();
      } else {
        log.trace(
          `not kicking player/socket ${
            this.player?.getUUID() || '*uninitialised*'
          } since they've been active`
        );
      }
    }, 60 * 1000);
  }

  send(response: MessageHandlerResponse) {
    const serialiser = stringifiers[response.type] || JSON.stringify;

    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        const outgoingJson = serialiser({
          type: response.type,
          data: response.data,
          sequence: this.getSequenceNumber(),
        });
        log.trace('sending JSON to client:%j', outgoingJson);
        this.ws.send(outgoingJson);
      } else {
        log.warn(
          'Attempted to send message on closed socket for player: %j',
          this.player?.getUUID()
        );
      }
    } catch (error) {
      log.error('Failed to send ws message. Error: %j', error);
    }
  }

  async processMessage(data: WebSocket.Data) {
    if (this.isLocked()) {
      log.warn(
        `cannot process message for ${this.getPlayer()?.getUUID()}. We're already processing one on their behalf!`
      );
      this.send({
        type: OutgoingMsgType.PleaseWait,
        data: {
          info:
            'Already processing a message on your behalf. Slow down there kiddo!',
        },
      });
    } else {
      log.trace(`processing incoming socket data: ${data.toString()}`);

      // Lock the socket mutex. Any new messages received from a client will be
      // ignored until we finish processing the current message.
      this.lock();

      // Note the time that we received this message. This can be used to close
      // inactive sockets that are hanging around
      this.lastRecvTs = Date.now();

      try {
        const json = JSON.parse(data.toString());
        const valid = validators.validatePayload(json);

        if (!valid) {
          if (validators.validatePayload.errors) {
            throw new ValidationError(validators.validatePayload.errors);
          } else {
            throw new Error(
              'Ajv validation failed, but no errors are available to display.'
            );
          }
        }

        this.send(await processSocketMessage(this, json as WsPayload));
      } catch (e) {
        if (e instanceof SyntaxError) {
          log.error(
            'received malformed socket message JSON/Buffer. Buffer contained:\n%j',
            data.toString()
          );
          this.send({
            type: OutgoingMsgType.BadPayload,
            data: {
              info: 'Your JSON payload was a bit iffy. K thx bye.',
            },
          });
        } else if (e instanceof ValidationError) {
          log.warn(
            `message failed schema validation with reason "${e.errors
              .map((e) => `${e.instancePath}: ${e.message}`)
              .join(', ')}" for data: ${data.toString()}`
          );
          this.send({
            type: OutgoingMsgType.BadPayload,
            data: {
              info: e.errors,
            },
          });
        } else if (e instanceof HandlerNotFoundError) {
          this.send({
            type: OutgoingMsgType.BadMessageType,
            data: {
              info: `"${e.type}" is an unrecognised message type`,
            },
          });
        } else {
          log.error(`error processing an incoming message: ${data.toString()}`);
          log.error(e);
          this.send({
            type: OutgoingMsgType.ServerError,
            data: {
              info:
                NODE_ENV == 'dev'
                  ? e instanceof Error
                    ? e.message
                    : 'unknown error'
                  : 'there was an error processing your payload',
            },
          });
        }
      } finally {
        // Lift the mutex so the client can send more messages to the server
        this.unlock();
      }
    }
  }

  close() {
    if (this.ws.readyState in [WebSocket.OPEN, WebSocket.CONNECTING]) {
      // Close with a "normal" 1000 close code
      this.ws.close(1000);
    }
    clearInterval(this.kickTimer);
  }

  isLocked() {
    return this.locked;
  }

  lock() {
    this.locked = true;
  }

  unlock() {
    this.locked = false;
  }

  setPlayer(player: Player) {
    this.player = player;
  }

  getPlayer() {
    return this.player;
  }

  getSequenceNumber() {
    return ++this.sequence;
  }
}
