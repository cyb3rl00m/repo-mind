export type EngineeringMode = 'architecture' | 'implementation' | 'debugging' | 'refactoring' | 'review' | 'testing' | 'emergency' | 'handoff';

export type PromptStage = 'understand' | 'plan' | 'implement' | 'review' | 'correct' | 'complete' | 'handoff';

export interface ModeDefinition {
  id: EngineeringMode;
  label: string;
  summary: string;
  role: string;
  /** Ordered prompt stages for this mode (local verification happens between implement/correct). */
  stages: PromptStage[];
  /** Mode-wide priorities, inserted into every stage prompt. */
  priorities: string[];
  /** Per-stage instruction overrides. */
  stageInstructions: Partial<Record<PromptStage, string[]>>;
}

export const MODES: Record<EngineeringMode, ModeDefinition> = {
  architecture: {
    id: 'architecture',
    label: 'Architecture',
    summary: 'Understand the existing architecture and design new features without unnecessary rewrites.',
    role: 'You are a principal software architect reviewing an existing codebase before a change. You design within the current architecture instead of replacing it.',
    stages: ['understand', 'plan', 'complete'],
    priorities: [
      'Describe the architecture that actually exists in the provided code (layers, modules, data flow, DI, navigation) before proposing anything.',
      'Prefer extending existing abstractions over introducing new frameworks, layers or patterns.',
      'Every proposed component must name the existing file/module it attaches to.',
      'Call out where the provided context is insufficient to judge a design question.'
    ],
    stageInstructions: {
      plan: [
        'Produce a design, not code: components, responsibilities, interfaces (signatures only), data flow and module placement.',
        'List alternatives you rejected and why (max 3).',
        'Give a migration path that keeps the app building at every step.'
      ]
    }
  },
  implementation: {
    id: 'implementation',
    label: 'Implementation',
    summary: 'Build complete features according to repository conventions.',
    role: 'You are a senior engineer implementing a feature in an existing production codebase. You follow its conventions exactly and deliver complete, compiling changes.',
    stages: ['understand', 'plan', 'implement', 'review', 'correct', 'complete'],
    priorities: [
      'Match the existing code style, naming, architecture layers, DI approach and error handling seen in the provided files.',
      'Implement every requirement completely — no stubs, no TODOs, no “left as an exercise”.',
      'Touch only what the task needs; preserve all unrelated behaviour.'
    ],
    stageInstructions: {}
  },
  debugging: {
    id: 'debugging',
    label: 'Debugging',
    summary: 'Trace bugs to their root cause instead of patching symptoms.',
    role: 'You are a senior engineer debugging a defect. You find the root cause with evidence from the code before changing anything.',
    stages: ['understand', 'plan', 'implement', 'correct', 'complete'],
    priorities: [
      'Separate symptoms from causes. Quote the exact lines that produce the faulty behaviour.',
      'Rank hypotheses by likelihood and say what evidence would confirm or refute each.',
      'The fix must address the root cause; mention any symptom-level guard you add and why.',
      'Add or update a test that fails before the fix and passes after it, when the project has tests.'
    ],
    stageInstructions: {
      understand: [
        'Do NOT write a fix yet.',
        'Restate the observed vs expected behaviour.',
        'Trace the execution path through the provided files (file:function chain).',
        'List ranked root-cause hypotheses with the code evidence for each.',
        'List the logs, inputs or files you would need to confirm the top hypothesis (only if truly missing).'
      ],
      plan: ['State the confirmed (or most likely) root cause with file + line evidence.', 'Describe the minimal correct fix and its side effects.', 'Describe the regression test.']
    }
  },
  refactoring: {
    id: 'refactoring',
    label: 'Refactoring',
    summary: 'Improve structure while preserving behaviour and public interfaces.',
    role: 'You are a senior engineer performing a behaviour-preserving refactoring.',
    stages: ['understand', 'plan', 'implement', 'review', 'correct', 'complete'],
    priorities: [
      'Observable behaviour must be identical before and after.',
      'Keep public signatures, serialized formats, database schemas and resource names unchanged unless the approved plan says otherwise.',
      'Move in small mechanical steps; every step must compile.',
      'Update every call site listed in the impact report.'
    ],
    stageInstructions: {
      plan: ['For every public API you would change, list all call sites from the impact report and how each is updated.', 'State how behaviour preservation will be verified (existing tests, new characterization tests).']
    }
  },
  review: {
    id: 'review',
    label: 'Code Review',
    summary: 'Inspect modifications for correctness, security, maintainability and regressions.',
    role: 'You are a strict senior code reviewer. You verify changes against the requirement and the existing code; you do not rubber-stamp.',
    stages: ['review'],
    priorities: [
      'Check every changed hunk against the surrounding code that is provided.',
      'Prioritize: correctness > regressions > security > data loss > performance > style.',
      'Only report issues you can point to in the diff or provided files.'
    ],
    stageInstructions: {}
  },
  testing: {
    id: 'testing',
    label: 'Testing',
    summary: 'Design and write relevant tests that run with the project’s existing test setup.',
    role: 'You are a senior test engineer adding tests to an existing project using its existing test frameworks.',
    stages: ['plan', 'implement', 'correct', 'complete'],
    priorities: [
      'Use only test frameworks and helpers already present in the project (see dependencies and existing tests).',
      'Place tests where existing tests live, following their naming.',
      'Cover the main path, edge cases and error handling; each test asserts something meaningful.',
      'Do not change production code unless required for testability — and explain each such change.'
    ],
    stageInstructions: {
      plan: ['List test cases (name, scenario, expected result) grouped by file.', 'Name the exact command that runs them (from the project’s build system).']
    }
  },
  emergency: {
    id: 'emergency',
    label: 'Emergency Fix',
    summary: 'Smallest safe correction for an urgent failure.',
    role: 'You are an on-call engineer producing the smallest safe fix for an urgent production/build failure.',
    stages: ['implement', 'correct', 'complete'],
    priorities: [
      'Smallest possible diff that fixes the failure. No refactoring, no cleanup, no new dependencies.',
      'Prefer reverting to known-good behaviour over clever fixes.',
      'State the root cause in one or two sentences and any follow-up work required for a proper fix.'
    ],
    stageInstructions: {
      implement: ['Start with a 2–4 line diagnosis citing the failing file/line.', 'Then give the minimal diff.', 'Then list follow-ups.']
    }
  },
  handoff: {
    id: 'handoff',
    label: 'Project Handoff',
    summary: 'Produce a comprehensive development handoff for another AI coding assistant.',
    role: 'You are the departing lead engineer writing a precise handoff for the next engineer/AI assistant.',
    stages: ['handoff'],
    priorities: ['Only state facts present in the provided memory, index summary and files; mark anything uncertain as such.', 'Be concrete: file paths, module names, commands.'],
    stageInstructions: {}
  }
};

export const STAGE_LABELS: Record<PromptStage, string> = {
  understand: 'Understand',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  correct: 'Correct',
  complete: 'Complete',
  handoff: 'Handoff'
};
