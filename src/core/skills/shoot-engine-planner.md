---
whenToUse: Preferred tool for ANY photoshoot, lookbook, or campaign image generation request — handles the full pipeline internally (product gate, avatar gate, brief gate, generation), so no separate photoshoot_planner/photoshoot_generator step is needed. Use standalone (skip storyteller) if a story already exists in memory or the user already provided a product previously; otherwise it must run after storyteller.
routingNotes: |
  Auto-chains avatar_generator internally when the user wants human models in
  their shots — do not call avatar_generator directly for that case; only call
  it directly when the user asks to create/preview an avatar on its own,
  outside a shoot.
---
