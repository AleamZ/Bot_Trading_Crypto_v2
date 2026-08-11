import type { DomainEvent } from "../../domain/events/DomainEvent.js";
import type { TradingRepository } from "../ports/Repositories.js";
import type { DecisionLogger } from "../ports/Logger.js";

type Handler = (event: DomainEvent) => Promise<void> | void;

export class EventBus {
  private readonly handlers = new Map<DomainEvent["type"], Handler[]>();

  constructor(
    private readonly repository: TradingRepository,
    private readonly logger: DecisionLogger
  ) {}

  on<T extends DomainEvent["type"]>(type: T, handler: (event: Extract<DomainEvent, { type: T }>) => Promise<void> | void): void {
    const current = this.handlers.get(type) ?? [];
    current.push(handler as Handler);
    this.handlers.set(type, current);
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.repository.appendEvent(event);
    this.logger.info(event.type, { event });
    for (const handler of this.handlers.get(event.type) ?? []) {
      await handler(event);
    }
  }
}
