import type { Analyzer } from './types.js';

/** M1 占位：不做任何内容判定。M2 换成真的 LLM Analyzer。 */
export class NoopAnalyzer implements Analyzer {
  readonly name = 'noop';

  async analyze(): Promise<null> {
    return null;
  }
}
