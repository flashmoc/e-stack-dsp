"use strict";

const fs = require("fs");
const crypto = require("crypto");

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.fchmodSync(fd, mode); // Restore exact existing permissions despite umask.
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function read(file) {
  const records = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  if (!Array.isArray(records))
    throw new Error("Saved configuration collection is invalid");
  return records;
}

// Synchronous read/modify/atomic rename: no await window between collection
// read and write in the single E-Stack DSP process.
function update(file, mutate) {
  const records = read(file);
  const result = mutate(records);
  atomicWrite(file, records);
  return result;
}

const revision = (records) =>
  `"${crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex")}"`;
module.exports = { atomicWrite, read, update, revision };
