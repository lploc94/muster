import type { ToolCallHandler } from '../bridge/server';
import type { CredentialContext } from '../bridge/credentials';
import type { ToolCommand } from '../task/coordinator-tools';
import type { PresentationManager, PresentationUpsertRequest } from './presentation-manager';

export class PresentationToolRouter implements ToolCallHandler {
  constructor(
    private readonly delegate: ToolCallHandler,
    private readonly manager: Pick<PresentationManager, 'upsert'>,
  ) {}

  async handleToolCall(
    context: CredentialContext,
    tool: string,
    command: ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (command.kind !== 'upsert_presentation') {
      return this.delegate.handleToolCall(context, tool, command);
    }
    if (!context.allowedActions.has('upsert_presentation')) {
      return { ok: false, error: 'unauthorized' };
    }

    const request: PresentationUpsertRequest = {
      presentationId: command.presentationId,
      ownerTaskId: command.ownerTaskId,
      opId: command.opId,
      ...(command.revision !== undefined ? { revision: command.revision } : {}),
      title: command.title,
      markdown: command.markdown,
      ...(command.presentationKind !== undefined ? { kind: command.presentationKind } : {}),
      ...(command.summary !== undefined ? { summary: command.summary } : {}),
      ...(command.changeSummary !== undefined ? { changeSummary: command.changeSummary } : {}),
    };
    let result;
    try {
      result = await this.manager.upsert(
        {
          rootId: context.rootId,
          callerTaskId: context.callerTaskId,
          turnId: context.turnId,
        },
        request,
      );
    } catch {
      return { ok: false, error: 'panel_open_failed' };
    }
    return result.ok
      ? { ok: true, result: { code: result.code } }
      : { ok: false, error: result.code };
  }
}
