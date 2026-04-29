export interface Photoshoot {
  url: string;
  concept?: string;
  shotId?: string;
  story?: string;
}

export interface Avatar {
  name: string;
  description: string;
  image: string;
}

export interface InstaPost {
  image: string;
  captions: string[];
  story: string;
}

export interface Video {
  url: string;
  story: string;
}

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "status"; content: string }
  | { type: "canvas_info"; data: any }
  | { type: "canvas_story"; content: string }
  | { 
      type: "choice_questionnaire"; 
      questionId?: string; // NEW: Stable ID for deterministic mapping
      content: {
        title: string;
        question: string;
        options: Array<{
          id: string;
          label: string;
          description?: string;
        }>;
      }
    }
  | { type: "plan"; summary: string; steps: string[]; needsApproval: true }
  | { type: "approval_result"; approved: boolean }
  | { type: "photoshoots"; items: Photoshoot[] }
  | { type: "avatars"; items: Avatar[] }
  | { type: "insta_post"; data: InstaPost }
  | { type: "videos"; items: Video[] }
  | { type: "done" }
  | { type: "error"; message: string };

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
    pendingQuestion: { id: string } | null;
    pendingTasks: Task[];
  };
  plannedShots?: any[];
  productLock?: any;
  projectId?: string;
  userId?: string;
}



