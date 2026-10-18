'use strict';

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, profiles: {}, rooms: {} };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = {
          version: 1,
          profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
          rooms: parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {}
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.flush();
    }
    return this.data;
  }

  getData() { return this.data; }

  setData(next) {
    this.data = next;
    return this.flush();
  }

  flush() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    });
    return this.writeQueue;
  }
}

module.exports = { JsonStore };
