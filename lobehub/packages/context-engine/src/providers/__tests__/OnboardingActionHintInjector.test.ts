import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import { OnboardingActionHintInjector } from '../OnboardingActionHintInjector';
import type { OnboardingContext } from '../OnboardingContextInjector';

const createContext = (messages: any[]): PipelineContext => ({
  initialState: { messages: [] },
  isAborted: false,
  messages,
  metadata: {},
});

const buildProvider = (phaseGuidance: string, context?: Partial<OnboardingContext>) =>
  new OnboardingActionHintInjector({
    enabled: true,
    onboardingContext: {
      ...context,
      personaContent: '# Persona',
      phaseGuidance,
      soulContent: '# SOUL',
    },
  });

describe('OnboardingActionHintInjector', () => {
  describe('agent identity reminder', () => {
    it('separates assistant naming from account displayName hints', async () => {
      const provider = buildProvider('Phase: Agent Identity. Name the assistant.', {
        userInfo: { displayName: 'anbex' },
      });
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: '叫你摸鱼大师，头像用 🎣', role: 'user' },
        ]),
      );

      const last = result.messages.at(-1);
      expect(last?.content).toContain('X is agentName');
      expect(last?.content).toContain('Y is agentEmoji');
      expect(last?.content).toContain('anbex');
      expect(last?.content).toContain('describe the user, not the assistant');
      expect(last?.content).toContain('Do NOT include fullName in the same saveUserQuestion call');
    });
  });

  describe('discovery turn reminder', () => {
    const phaseGuidance = 'Phase: Discovery. Explore the user world.';

    it('injects current discovery progress when more discovery turns are recommended', async () => {
      const provider = buildProvider(phaseGuidance, {
        discoveryUserMessageCount: 1,
        remainingDiscoveryExchanges: 2,
      });
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: 'I mostly write docs', role: 'user' },
        ]),
      );

      const last = result.messages.at(-1);
      expect(last?.content).toContain('SYSTEM REMINDER: Current Discovery turn status');
      expect(last?.content).toContain('User discovery exchanges observed: 1');
      expect(last?.content).toContain('Recommended target before Summary: 3');
      expect(last?.content).toContain('Continue Discovery for about 2 more user exchange(s)');
    });

    it('reminds the model to move toward summary after the recommended target is reached', async () => {
      const provider = buildProvider(phaseGuidance, {
        discoveryUserMessageCount: 3,
        remainingDiscoveryExchanges: 0,
      });
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: 'I need help with planning and writing', role: 'user' },
        ]),
      );

      const last = result.messages.at(-1);
      expect(last?.content).toContain('Recommended Discovery target has been reached');
      expect(last?.content).toContain('transition to Summary');
    });
  });

  describe('turn order reminder', () => {
    it('always warns against bundling a question into a tool-call message', async () => {
      const provider = buildProvider('Phase: User Identity. Learn who the user is.');
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: 'hi', role: 'user' },
        ]),
      );

      const last = result.messages.at(-1);
      expect(last?.content).toContain('TURN ORDER');
      expect(last?.content).toContain(
        'never put a user-facing question in the same message as a tool call',
      );
    });
  });

  describe('summary completion guidance', () => {
    const phaseGuidance = 'Phase: Summary. Wrap-up.';

    it('finishes onboarding directly without opening template selection', async () => {
      const provider = buildProvider(phaseGuidance);
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: 'hi', role: 'user' },
          { content: 'hello', role: 'assistant' },
        ]),
      );
      const last = result.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.content).toContain('THIS TURN call `finishOnboarding`');
      expect(last?.content).toContain('Template selection has been removed');
    });

    it('keeps finishing directly even when unrelated tool calls exist', async () => {
      const provider = buildProvider(phaseGuidance);
      const result = await provider.process(
        createContext([
          { content: 'sys', role: 'system' },
          { content: 'hi', role: 'user' },
          {
            content: '',
            role: 'assistant',
            tools: [
              {
                apiName: 'saveUserQuestion',
                arguments: '{}',
                id: 'call_1',
                identifier: 'lobe-web-onboarding',
                type: 'default',
              },
            ],
          },
        ]),
      );
      const last = result.messages.at(-1);
      expect(last?.content).toContain('THIS TURN call `finishOnboarding`');
    });
  });
});
