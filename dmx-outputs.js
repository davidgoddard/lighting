// Keep the control plane alive while USB outputs disconnect and re-enumerate.
export async function createDmxOutputs(factories, { now = () => performance.now(), retryMs = 5000, log = console } = {}) {
  const slots = factories.map(open => ({ open, transport: null, nextAttempt: 0, error: null }));
  let stopped = false;
  let pending = Promise.resolve();
  const connected = () => slots.filter(slot => slot.transport);
  const closeSlot = async slot => {
    const transport = slot.transport;
    slot.transport = null;
    try { await transport?.close(); } catch { /* A detached USB device may already be closed. */ }
  };
  async function scan() {
    await Promise.all(slots.map(async slot => {
      if (stopped || slot.transport || now() < slot.nextAttempt) return;
      slot.nextAttempt = now() + retryMs;
      try {
        slot.transport = await slot.open();
        if (slot.transport) {
          log.log(`Connected to ${slot.transport.name}.`);
          slot.error = null;
        }
      } catch (error) {
        if (slot.error !== error.message) log.warn(`Could not open a DMX output: ${error.message}`);
        slot.error = error.message;
      }
    }));
  }
  await scan();
  if (!connected().length) log.warn('No DMX output connected; web and bridge controls remain available. Retrying every 5 seconds.');
  return {
    get name() { return connected().map(slot => slot.transport.name).join(' + '); },
    get status() { return { connected: connected().length > 0, outputs: connected().map(slot => slot.transport.name) }; },
    send(universe) {
      const send = async () => {
        if (stopped) return false;
        await scan();
        const active = connected();
        await Promise.all(active.map(async slot => {
          try { await slot.transport.send(universe); }
          catch (error) {
            log.warn(`${slot.transport.name} disconnected: ${error.message}. Retrying in 5 seconds.`);
            await closeSlot(slot);
            slot.nextAttempt = now() + retryMs;
          }
        }));
        return connected().length > 0;
      };
      pending = pending.then(send);
      return pending;
    },
    async close() {
      stopped = true;
      await pending.catch(() => {});
      await Promise.all(slots.map(closeSlot));
    }
  };
}
