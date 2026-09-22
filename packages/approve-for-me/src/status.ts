import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "approve-for-me";
const RESULT_DURATION_MS = 1_500;

type StatusContext = Pick<ExtensionContext, "mode" | "ui">;

export class ReviewStatus {
  private readonly active = new Map<
    string,
    { ctx: StatusContext; message: string }
  >();
  private clearTimer?: ReturnType<typeof setTimeout>;
  private lastContext?: StatusContext;

  reviewingCommand(id: string, ctx: StatusContext): void {
    this.update(id, ctx, "◌ TypeSafe reviewing command…");
  }

  reviewingContext(
    id: string,
    ctx: StatusContext,
    risk?: number,
  ): void {
    const score =
      risk === undefined ? "" : ` · fast risk ${formatPercent(risk)}`;
    this.update(id, ctx, `◌ TypeSafe reviewing context${score}`);
  }

  awaitingHuman(
    id: string,
    ctx: StatusContext,
    unavailable: boolean,
  ): void {
    this.update(
      id,
      ctx,
      unavailable
        ? "! TypeSafe unavailable · awaiting human approval"
        : "! TypeSafe awaiting human approval",
    );
  }

  allowed(
    id: string,
    ctx: StatusContext,
    risk?: number,
    byHuman = false,
  ): void {
    const suffix = byHuman
      ? " · approved by human"
      : risk === undefined
        ? ""
        : ` · risk ${formatPercent(risk)}`;
    this.complete(id, ctx, `✓ TypeSafe allowed${suffix}`);
  }

  blocked(id: string, ctx: StatusContext, byHuman = false): void {
    this.complete(
      id,
      ctx,
      byHuman
        ? "✗ TypeSafe blocked by human"
        : "✗ TypeSafe blocked command",
    );
  }

  cancelled(id: string, ctx: StatusContext): void {
    this.complete(id, ctx, "✗ TypeSafe review cancelled");
  }

  clearActive(id: string, ctx: StatusContext): void {
    if (!this.active.delete(id)) return;
    this.renderActive(ctx);
  }

  dispose(): void {
    this.cancelClear();
    this.active.clear();
    this.setStatus(this.lastContext, undefined);
    this.lastContext = undefined;
  }

  private update(id: string, ctx: StatusContext, message: string): void {
    if (ctx.mode !== "tui") return;
    this.cancelClear();
    this.lastContext = ctx;
    this.active.set(id, { ctx, message });
    this.renderActive(ctx);
  }

  private complete(
    id: string,
    ctx: StatusContext,
    message: string,
  ): void {
    if (ctx.mode !== "tui") return;
    this.active.delete(id);
    this.lastContext = ctx;
    if (this.active.size > 0) {
      this.renderActive(ctx);
      return;
    }

    this.setStatus(ctx, message);
    this.cancelClear();
    this.clearTimer = setTimeout(() => {
      this.setStatus(ctx, undefined);
      this.clearTimer = undefined;
    }, RESULT_DURATION_MS);
    this.clearTimer.unref?.();
  }

  private renderActive(ctx: StatusContext): void {
    if (this.active.size === 0) {
      this.setStatus(ctx, undefined);
      return;
    }
    if (this.active.size > 1) {
      this.setStatus(
        ctx,
        `◌ TypeSafe reviewing ${this.active.size} commands…`,
      );
      return;
    }
    const current = this.active.values().next().value;
    this.setStatus(ctx, current?.message);
  }

  private cancelClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
  }

  private setStatus(
    ctx: StatusContext | undefined,
    message: string | undefined,
  ): void {
    if (ctx?.mode !== "tui") return;
    try {
      ctx.ui.setStatus(STATUS_KEY, message);
    } catch {
      // The UI may already be disposed during shutdown.
    }
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
