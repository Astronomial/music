const fs = require('node:fs/promises');
const path = require('node:path');
class Store {
  constructor(dir) { this.dir = dir; this.queue = Promise.resolve(); }
  async read(name, fallback) {
    let failure;
    for (const file of [name, name + '.bak']) {
      try { return JSON.parse(await fs.readFile(path.join(this.dir,file), 'utf8')); } catch (error) { if(error.code!=='ENOENT')failure ||= error; }
    }
    if(name==='library.json'&&failure)throw new Error('Не удалось прочитать библиотеку и резервную копию. Исходные файлы сохранены.',{cause:failure});
    return fallback;
  }
  write(name, data) {
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const dest = path.join(this.dir,name), temp = dest + '.tmp';
      await fs.writeFile(temp, JSON.stringify(data), 'utf8');
      try { JSON.parse(await fs.readFile(dest,'utf8'));await fs.copyFile(dest, dest + '.bak'); } catch {}
      await fs.rename(temp,dest);
    };
    this.queue = this.queue.then(run,run);
    return this.queue;
  }
}
module.exports = { Store };
