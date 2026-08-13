// Scheduler engine: background task runner.
// Polls schedule.json every 30s for due tasks and dispatches them via a
// caller-provided runTask callback. Designed to work in both terminal and
// desktop environments.

const schedule = require('./schedule');

const POLL_INTERVAL_MS = 30000; // check every 30 seconds

class Scheduler {
  // runTask(task) — async function that receives the scheduled task and returns
  // the result string. The caller provides the agent + permissions wiring.
  // onComplete(task, result) — optional callback after each task finishes.
  constructor({ runTask, onComplete } = {}) {
    this.runTask = runTask || (async (t) => `no runner configured for task "${t.title}"`);
    this.onComplete = onComplete || (() => {});
    this.timer = null;
    this.running = false;
    this.activeTaskId = null;
  }

  start() {
    if (this.timer) return; // already running
    // Fire immediately on start to catch missed tasks
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = schedule.getDueTasks();
      for (const task of due) {
        // Re-check time to avoid running tasks that fired while we were processing
        if (new Date(task.nextRun) > new Date()) continue;
        if (!task.enabled) continue;
        this.activeTaskId = task.id;
        try {
          const result = await this.runTask(task);
          schedule.markRan(task.id, result);
          this.onComplete(task, result);
        } catch (err) {
          const errorMsg = `ERROR: ${err.message}`;
          schedule.markRan(task.id, errorMsg);
          this.onComplete(task, errorMsg);
        }
        this.activeTaskId = null;
      }
    } finally {
      this.running = false;
    }
  }

  getStatus() {
    return {
      running: this.running,
      activeTaskId: this.activeTaskId,
      pollInterval: POLL_INTERVAL_MS,
    };
  }
}

module.exports = { Scheduler, POLL_INTERVAL_MS };