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
    avatarCustomDesc?: string;
    avatarImages?: AvatarImage[];
    models?: any[];
    projectId?: string;
    shootBriefChoice?: string;
    shootBrief?: string;
    // Resettable per-request gate (cleared once the shoot job finishes) — distinct
    // from conversation.answeredQuestions, which is a lifetime log and can't be
    // used to force re-confirmation on every new shoot request in a session.
    shootConfirmed?: boolean;
    shootCount?: number;
    shootEngineQueued?: boolean;
    // Avatar generate → approve → save-to-library flow
    avatarForShoot?: boolean; // true when this generation was chained in from a shoot request (gates garment reference)
    pendingAvatarImages?: AvatarImage[]; // generated, awaiting user approval — not yet saved
    pendingAvatarModel?: any;
    avatarApproved?: boolean;
    savedAvatarsChoice?: Array<{ id: string; name: string; images: AvatarImage[] }>; // options shown by the avatar_reuse picker
    awaitingProduct?: boolean; // a plain "please upload or describe" prompt was shown, no attachment yet
    // Vibe-picker gate (product-only shoots) — real Pinterest reference images.
    vibeCandidates?: Array<{ id: string; imageUrl: string; title: string; description: string; pinUrl?: string }>; // options shown at ask-time, resolved by id then cleared
    // "custom" = user opted out of the picker; string = an unresolved raw answer id (shouldn't
    // normally happen, but the extractor falls back to it rather than dropping the answer).
    vibeChoice?: string | { id: string; imageUrl: string; title: string; description: string; pinUrl?: string };
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
      options?: Array<{ id: string; label: string }>;
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



