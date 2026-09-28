/**
 * Broker Redis pub/sub în memorie: mai multe „conexiuni” (câte una per replică
 * simulată) împart același broker, ca într-un Redis real partajat.
 */
type MessageHandler = (channel: string, message: string) => void;

export class FakeRedisBroker {
  readonly connections: FakeRedisConnection[] = [];
  down = false;

  connect(): FakeRedisConnection {
    const conn = new FakeRedisConnection(this);
    this.connections.push(conn);
    return conn;
  }

  deliver(channel: string, message: string): number {
    let receivers = 0;
    for (const conn of this.connections) {
      if (conn.channels.has(channel)) {
        receivers += 1;
        conn.emitMessage(channel, message);
      }
    }
    return receivers;
  }
}

export class FakeRedisConnection {
  readonly channels = new Set<string>();
  readonly subscribeCalls: string[] = [];
  readonly unsubscribeCalls: string[] = [];
  status = "ready";
  private handlers: MessageHandler[] = [];

  constructor(private broker: FakeRedisBroker) {}

  on(event: string, handler: MessageHandler): this {
    if (event === "message") this.handlers.push(handler);
    return this;
  }

  emitMessage(channel: string, message: string): void {
    for (const h of this.handlers) h(channel, message);
  }

  async subscribe(channel: string): Promise<number> {
    if (this.broker.down) throw new Error("ECONNREFUSED");
    this.subscribeCalls.push(channel);
    this.channels.add(channel);
    return this.channels.size;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.unsubscribeCalls.push(channel);
    this.channels.delete(channel);
    return this.channels.size;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.broker.down) throw new Error("ECONNREFUSED");
    return this.broker.deliver(channel, message);
  }
}
