export type ChatEvent =
  | {
      type: "chat_text";
      ai?: string; // conversational/final reply text
      status?: string; // transient real-time progress narration ("Generating: Hero shot...")
      plan?: { summary: string; steps: string[] }; // proposed plan awaiting approval
      plan_done?: boolean; // plan approved / execution complete signal
      questionnaire?: {
        questionId?: string; // stable ID for deterministic mapping
        title?: string;
        question: string;
        options: Array<{
          id: string;
          label: string;
          description?: string;
        }>;
      };
      info?: any; // structured supplementary payload (brand strategy, moodboard, etc.)
    }
  | { type: "shoot_images"; items: Array<{ url: string; concept?: string }> }
  | { type: "social_images"; items: Array<{ url: string; caption?: string }> }
  | { type: "status"; content: string }
  // Structured questionnaire — the only variant the frontend's SSE parser actually
  // renders as a clickable question (chat_text.questionnaire falls through unrendered).
  // questionId is used both to route the user's next answer (Orchestrator.extractAnswer)
  // and, on the frontend, to key the answer back to this specific question.
  | {
      type: "choice_questionnaire";
      questionId: string;
      content: {
        title?: string;
        question: string;
        options: Array<{ id: string; label: string; description?: string }>;
      };
    }
  // Final generated shots — matches the shape ShootEngine's queue path already streams
  // and that the frontend's canvas already knows how to place.
  | {
      type: "photoshoots";
      items: Array<{
        shotIndex: number;
        url: string;
        theme?: string;
        concept?: string;
        assetId?: string;
        r2Key?: string;
        prompt?: string;
        runId?: string; // groups shots from the same generation run for placeholder matching
      }>;
    }
  // Reserves a canvas slot with a loading placeholder before the matching photoshoots
  // item (same shootIndex + runId) arrives.
  | { type: "shoot_generating"; shootIndex: number; theme?: string; runId?: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "queued"; jobId: string; sessionId: string }
  // SSE keepalive — not a status update. Kept out of "chat_text" so the client
  // doesn't render it as narration and blank out a real status line.
  | { type: "heartbeat" };

export type ToolResponse = {
  visible?: ChatEvent[];
  hidden?: any; // Keep for legacy compat
  memoryUpdate?: Partial<SessionMemory>; // NEW: updates to merge into SessionMemory
  nextTasks?: Task[];                    // NEW: dynamic tool chaining
  pauseForUserInput?: boolean;           // NEW: explicit pause signal
  nextInput?: any;                       // pass to next tool
};

export interface Task {
  id: string;
  tool: string;
  input?: any;
  dependsOn?: string[];
}

export interface AvatarImage {
  angleId: string;
  r2Key: string;
  signedUrl: string;
}

export interface SessionMemory {
  product?: {
    source?: string;
    productLocked: boolean;
    primaryAssetKey?: string;
    primaryAssetId?: string;
    assetIds?: string[];
    name?: string;
    colors?: string[];
    tags?: string[];
    description?: string;
    details?: any;
    productConstraints?: any;
  };

  creative?: {
    story?: string;
    // The user's own answer to StorytellerTool's pre-generation direction
    // gate — "ai_decide" or "custom", plus the free-text brief when custom.
    userBriefChoice?: string;
    userBrief?: string;
    // Audience/goal/mood/must-include-avoid gathered via story_context_gate when
    // the user delegated the narrative ("Develop it for me") — "" if they skipped it.
    userContext?: string;
    style?: {
      vibe?: string;
      aesthetic?: string;
      lighting?: string;
      color_palette?: string[];
      composition?: string;
    };
    moodboardImages?: string[];
    canvasInfo?: any;
  };
  campaign?: {
    avatarChoice?: string;
    useAvatar?: boolean;
    avatarPrefs?: string;
    // Human-readable label for avatarPrefs (its option id is meaningless on
    // its own — this is the actual casting description to hand downstream).
    avatarPrefsLabel?: string;
    avatarCustomDesc?: string;
    avatarImages?: AvatarImage[];
    models?: any[];
    projectId?: string;
    shootBriefChoice?: string;
    shootBrief?: string;
    // Pinterest-backed vibe picker (Gate 1a) — vibeCandidates holds the fetched
    // options awaiting a choice; vibeChoice is either "custom" or the selected
    // candidate (kept as the full object, not just its id, so shootBrief can be
    // built from its description/title after the picker clears).
    vibeChoice?: string | { id: string; title?: string; description?: string; [key: string]: any };
    vibeCandidates?: Array<{ id: string; title?: string; description?: string; [key: string]: any }>;
    // Resettable per-request gate (cleared once the shoot job finishes) — distinct
    // from conversation.answeredQuestions, which is a lifetime log and can't be
    // used to force re-confirmation on every new shoot request in a session.
    shootConfirmed?: boolean;
    shootCount?: number;
    // A boolean-only "in flight" guard can get stuck forever if the job that's
    // supposed to clear it never reports back (queue message lost, worker
    // reload/crash mid-flight, RPC failure) — nothing else can ever unset it.
    // shootEngineQueuedAt makes the guard self-expiring: SimpleShootPlannerTool
    // treats it as stale (and proceeds as if unqueued) past SHOOT_QUEUE_GUARD_TTL_MS,
    // so a lost job degrades to "you can try again shortly" instead of a
    // permanently jammed session. Persisted in durable memory, so — unlike an
    // in-process timer — this survives DO restarts/hibernation too.
    shootEngineQueued?: boolean;
    shootEngineQueuedAt?: number;
    // Avatar generate → approve → save-to-library flow
    avatarForShoot?: boolean; // true when this generation was chained in from a shoot request (gates garment reference)
    pendingAvatarImages?: AvatarImage[]; // generated, awaiting user approval — not yet saved
    pendingAvatarModel?: any;
    avatarApproved?: boolean;
    savedAvatarsChoice?: Array<{ id: string; name: string; images: AvatarImage[] }>; // options shown by the avatar_reuse picker
    awaitingProduct?: boolean; // a plain "please upload or describe" prompt was shown, no attachment yet
  };
  conversation: {
    answeredQuestions: string[];
    allAttachments?: any[];
    assetRefs?: Array<{
      assetId: string;
      r2Key: string;
      label: string;
      role: string;
      mimeType: string;
      colors: string[];
      tags: string[];
    }>;
  };

  flowControl: {
    pendingQuestion: {
      id: string;
      // Captured at ask-time so the next turn can validate an incoming answer
      // before blindly extracting it. [] = free-text gate (no fixed options).
      // undefined = legacy pendingQuestion persisted before this field existed —
      // must NOT be treated as "no valid answers" (see Orchestrator.answerMatchesPending).
      options?: Array<{ id: string; label: string; description?: string }>;
    } | null;
    pendingTasks: Task[];
    activeShootJobId?: string;
  };
  plannedShots?: any[];
  productLock?: any;
  projectId?: string;
  userId?: string;

  // Populated by MemoryRecallTool before other tools run.
  // All subsequent tools read from here instead of hitting the DB themselves.
  memoryContext?: {
    brand: {
      tone?: string | null;
      aesthetic?: string | null;
      coreStory?: string | null;
      colorPalette?: any[];
      targetAudience?: string | null;
      visualMood?: string | null;
      lightingStyle?: string | null;
    } | null;
    insights: { insight: string; category: string; confidence: number }[];
    graph: string[];
    episodic: { summary: string; feedbackScore: number; feedbackHint?: string }[];
    retrievedAt: string;
  };
}



