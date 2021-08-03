const services = require('./services');
const responseMediators = require('../responseMediators');
const errors = require('../errors');
const utils = require('../utils');
const Pulsar = require('../client');
const pulsarApi = require('../commands/protocol/pulsar/pulsar_pb');

const ACCESS_MODES = pulsarApi.ProducerAccessMode;

class Producer {
  constructor({ pulsar, topic, discoveryServers, jwt, producerAccessMode }) {
    this._client = new Pulsar({
      discoveryServers,
      jwt,
    });
    this._topic = topic;
    this._producerAccessMode = producerAccessMode;
    this._requestId = 0;
    this._producerId = 0;
    this._producerName = null;
    this._createCloseResponseMediator = new responseMediators.RequestIdResponseMediator({
      client: this._client,
      commands: ['producerSuccess', 'success', 'error'],
    });
    this._sendResponseMediator = new responseMediators.SendResponseMediator({
      client: this._client,
      commands: ['sendReceipt', 'sendError'],
      producerAccessMode,
    });
    this._connected = false;
    services.producerClose({
      client: this._client,
      create: this.create,
      setConnected: this._setConnected,
      sendResponseMediator: this._sendResponseMediator,
    });
  }

  _setConnected = (connected) => (this._connected = connected);

  create = async () => {
    await this._client.connect({ topic: this._topic });
    this._setConnected(true);
    await this._client
      .getCnx()
      .addCleanUpListener(async () => await services.reconnect(this.create, this._setConnected));
    const { command } = await services.create({
      topic: this._topic,
      requestId: this._requestId,
      producerId: this._producerId,
      producerName: this._producerName,
      client: this._client,
      responseMediator: this._createCloseResponseMediator,
      producerAccessMode: this._producerAccessMode,
    });
    const { producerName, lastSequenceId } = command;
    this._requestId++;
    this._producerName = producerName;
    this._sequenceId = lastSequenceId + 1;
    return true;
  };

  close = async () => {
    await services.close({
      producerId: this._producerId,
      client: this._client,
      requestId: this._requestId,
      responseMediator: this._createCloseResponseMediator,
    });
    this._requestId++;
    return true;
  };

  sendMessage = async ({ payload, properties }) => {
    if (utils.isNil(payload)) throw new errors.PulsarFlexNoPayloadError();
    try {
      await services.sendMessage({
        producerId: this._producerId,
        producerName: this._producerName,
        client: this._client,
        sequenceId: this._sequenceId,
        responseMediator: this._sendResponseMediator,
        payload,
        properties,
      });
    } catch (e) {
      await new Promise(async (resolve, reject) => {
        this._client.getResponseEvents().once('producerSuccess', () => {
          resolve(this.sendMessage({ payload, properties }));
        });
      });
    }
    this._sequenceId++;
    return true;
  };

  sendBatch = async ({ messages }) => {
    try {
      await services.sendBatch({
        producerId: this._producerId,
        producerName: this._producerName,
        client: this._client,
        sequenceId: this._sequenceId,
        responseMediator: this._sendResponseMediator,
        messages,
      });
    } catch (e) {
      return await new Promise(async (resolve, reject) => {
        this._client.getResponseEvents().once('producerSuccess', () => {
          resolve(this.sendBatch({ messages }));
        });
      });
    }

    this._sequenceId++;
    return true;
  };

  static get ACCESS_MODES() {
    return ACCESS_MODES;
  }
}

module.exports = Producer;
