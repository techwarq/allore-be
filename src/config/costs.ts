/**
 * Centralized configuration for all credit costs, plans, and billing rules.
 * Use this file to manage pricing without touching service logic.
 */

export const COSTS = {
    images: {
        gpt_image_2_high:  3,   // $0.211 your cost
        nano_banana_2:     1,   // $0.067 your cost
        blended:           4,   // $0.278 your cost (1 GPT + 1 NB2)
    },

    videos: {
        "12sec_720p":  20,  // $1.78 your cost
        "15sec_720p":  25,  // $2.22 your cost
        "12sec_1080p": 45,  // $4.01 your cost
        "15sec_1080p": 55,  // $5.01 your cost
    },
} as const;

export const PLANS = {
    basic: {
        price:          99,
        creditsPerMonth: 600,
        rollover:       false,
        rolloverLimit:  0,
    },

    pro: {
        price:           199,
        creditsPerMonth: 1300,
        rollover:        false,
        rolloverLimit:   0,
    },

    max: {
        price:           399,
        creditsPerMonth: 2200,
        rollover:        true,
        rolloverLimit:   500,   // max credits that carry over
    },
} as const;

export const TOPUPS = {
    starter: { credits: 100,  price: 14.99 },
    boost:   { credits: 300,  price: 39.99 },
    power:   { credits: 600,  price: 69.99 },
    mega:    { credits: 1500, price: 149.99 },
} as const;

export const BONUSES = {
    daily_login:      5,
    complete_profile: 20,
    refer_friend:     100,
    annual_plan:      500,
    three_month_streak: 50,
    leave_review:     30,
    social_share:     10,
} as const;

export const ANNUAL_DISCOUNT = {
    basic: { monthlyPrice: 79,  bonusCredits: 500  },
    pro:   { monthlyPrice: 159, bonusCredits: 1000 },
    max:   { monthlyPrice: 319, bonusCredits: 2500 },
} as const;

// warning thresholds — % of credits USED
export const CREDIT_WARNINGS = {
    caution:  0.70,  // 70% used  → banner
    warning:  0.80,  // 80% used  → email
    critical: 0.90,  // 90% used  → in-app popup
    urgent:   0.95,  // 95% used  → "almost out"
    blocked:  1.00,  // 100% used → soft block
} as const;

// types
export type ImageType  = keyof typeof COSTS.images;
export type VideoType  = keyof typeof COSTS.videos;
export type PlanType   = keyof typeof PLANS;
export type TopupType  = keyof typeof TOPUPS;
