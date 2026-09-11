"""English LLM prompts for film_summary + short mix-cut (Narrato logic)."""

from __future__ import annotations

from typing import Any

PLOT_SYSTEM = (
    "You are a professional film-commentary planner and story analyst. "
    "Output restrained, structured plot notes for a downstream commentary script writer. "
    "Do not greet the user."
)

PLOT_TEMPLATE = """# Role
You produce structured plot notes for a film/TV commentary script generator. This is NOT viewer-facing copy.

# Input notes
The input may contain one or more video subtitle files, and may also include web-search context.
- Web search may only help identify the title, character relations, era, and public synopsis.
- Original subtitles are the only trusted source of facts for the current footage.
- If web search conflicts with subtitles, subtitles win.
- If web search mentions later plot not yet in the subtitles, put it under uncovered/caution — never as current facts.
- Multi-file subtitles are headed like "Video 1: filename". Timestamps are local to that file, not a concatenated timeline.

# Tasks
1. Identify title, subtitle range, video sources, web-search notes, and fact boundary.
2. Unify character names; map relations, motives, and stance changes.
3. Summarize the covered plot in 120-220 words without spoiling events not in the subtitles.
4. Split key story beats in subtitle order with accurate video_id / video_name / timestamps.
5. Extract commentary assets: opening hook, character dilemma, emotional turns, information reversals, signature scenes, suggested original-audio clips.

# Hard rules
1. No chatty openings.
2. Do not invent events, dialogue, relationships, or endings absent from the subtitles.
3. Timestamps must come from the matching video's subtitles; if unknown write "unclear from subtitles".
4. In multi-video input, never mix same-looking timestamps from different files.
5. Unify names: prefer official names from web search; keep subtitle aliases in the character table.
6. Be concise and reusable. No literary padding.
7. Follow the Markdown sections below. No extra chapters.

# Output format
## I. Basic identification
- Title: [or Unknown]
- Subtitle range: [start] --> [end]; or "unclear from subtitles"
- Video sources: [id, filename, subtitle range]
- Web-search confirmation: [or Not enabled]
- Facts actually in subtitles: [2-5 bullets]
- Uncovered / caution: [web-only facts not in subtitles, or None]

## II. Characters and relations
| Unified name | Subtitle alias | Role / relation | Current motive / stance | Confidence |
|---|---|---|---|---|
| ... | ... | ... | ... | subtitle / web-assist / inference |

## III. Overall plot summary
[120-220 words covering conflict, motive, progression, current suspense.]

## IV. Beat breakdown
| Video | Timestamp | Beat title | What happens | Narrative function |
|---|---|---|---|---|
| [video_id + video_name] | [start] --> [end] | ... | ... | setup / rising / character / reversal / suspense / climax |

## V. Commentary focus
- Opening hook: ...
- Core conflict: ...
- Emotional turns / reversals: ...
- Signature scenes / dialogue: ...
- Closing beat (what the recap should wrap, without inventing a finale absent from subtitles): ...
- Open questions: ...
- Suggested original-audio clips:
  1. [video_id + video_name + timestamp]: [why keep original audio, or None]

## VI. Web-search check
- Usable background: ...
- Conflicts or uncovered items: ...

# Input
${subtitle_content}
"""

COPY_SYSTEM = (
    "You write film/TV commentary narration. Output only reviewable spoken prose. "
    "Always end with a short spoken closing wrap. "
    "No JSON, timestamps, numbering, titles, explanations, or Markdown."
)

COPY_TEMPLATE = """# Task
Write spoken commentary for "${drama_name}" that a human can edit. Do not match shots or emit timestamps.

## Plot notes
<plot>
${plot_analysis}
</plot>

## Original subtitles
<subtitles>
${subtitle_content}
</subtitles>

## Spoken language
<narration_language>
${narration_language}
</narration_language>

## User-selected genre
<drama_genre>
${drama_genre}
</drama_genre>

## Target length
<narration_word_count>
${narration_word_count}
</narration_word_count>

## Genre emphasis (do not reclassify the genre)
- Drama / emotion: choices, relationship fractures, fate pressure, aftertaste.
- Mystery / crime: clues, doubts, motive, misdirection, unrevealed truth.
- Action / adventure: goals, escalating danger, physical stakes, key decisions.
- Comedy / light: misunderstandings, contrast, timing, charm.
- Sci-fi / fantasy: rules of the world, unknown threat, cost of power.
- History / war: era pressure, faction choices, sacrifice, shifting odds.
- Horror / thriller: uncanny detail, dread, unseen danger, psychological suspense.
- Custom: follow the user's genre string exactly.

## Opening hook
Use "character pressure + abnormal information + a question":
1. The pressure the lead faces.
2. A fact that breaks common sense, a relationship shock, or a danger spike.
3. A question the viewer wants answered.

## Closing wrap (required)
After the last story beat, add 1–2 spoken sentences that close the recap like a host signing off.
This is meta wrap-up, not a new plot event. Do not invent a film finale that is not in the plot notes / subtitles.
If the covered footage already reaches a resolution, acknowledge that close. If it does not, close the recap's journey only.
Write the wrap in ${narration_language}. Match this tone (adapt, do not copy verbatim unless it fits):
- "Đến đây, hành trình của nhân vật chính cũng chính thức khép lại."
- "Vậy là chúng ta đã đi hết câu chuyện này. Nếu là bạn, bạn sẽ lựa chọn như thế nào?"
- "Một hành trình đầy biến cố cuối cùng cũng đi đến hồi kết."
- "Và đó chính là toàn bộ câu chuyện. Một cú plot twist mà có lẽ không ai ngờ tới."
- "Câu chuyện đến đây là hết, nhưng liệu bạn có đoán được kết cục này ngay từ đầu?"
Use a twist/question closer only when the covered plot actually has a twist or unresolved choice. Otherwise pick a quieter close.
The wrap must be the final sentences of the narration body.

## Writing rules
1. Write in ${narration_language}.
2. Stay inside plot notes and subtitle facts. Do not invent core plot, identity, or a film ending absent from the input.
3. Motives and cause-and-effect first; punchy lines second.
4. One idea per sentence so later matching can split by sentence.
5. Keep sentences short.
6. Every 2-3 sentences, bridge why we moved from the previous beat.
7. Aim for ${narration_word_count} words (±10%), including the closing wrap. CJK counts non-whitespace characters; other languages count words.
8. No numbered lists, bullets, headings, or parenthetical stage directions.

Output only the narration body.
"""

MATCH_SYSTEM = (
    "You are an editor who understands film rhythm. Output strict JSON only. "
    "Match the reviewed narration to the best original subtitle timestamps. "
    "Always emit a complete JSON object; never cut a string or array mid-value."
)

MATCH_TEMPLATE = """# Task
The user reviewed the commentary. Split it and match it to original subtitle timestamps. Produce a cuttable JSON script.

## Title
${drama_name}

## Plot notes
<plot>
${plot_analysis}
</plot>

## Reviewed narration
<narration_copy>
${narration_copy}
</narration_copy>

## Original subtitles (local timestamps per video)
<subtitles>
${subtitle_content}
</subtitles>

## Spoken language
<narration_language>
${narration_language}
</narration_language>

## Genre
<drama_genre>
${drama_genre}
</drama_genre>

## Original-audio duration target
<original_sound_ratio>
${original_sound_ratio}%
</original_sound_ratio>

## Matching steps
1. Split narration on periods, question marks, exclamation marks, ellipses.
2. Split on commas only when they separate distinct actions, scenes, or claims.
3. Adjacent sentences may merge as story bridges; do not change the user's meaning.
4. Never use openings, credits, copyright cards, watermarks, next-episode teasers, extras, sponsorships, product shots, or ads.
5. Skip ranges whose subtitle text signals ads, sponsors, openings, endings, previews, QR codes, purchases, membership, or follow-calls.
6. Pick the shot that best carries the sentence's meaning, character state, or information turn.
7. Estimate needed seconds ≈ character_count / 5 for CJK, or word_count / 2.5 for other languages. Prefer ±0.5s.
8. Split a long sentence into multiple OST=0 clips if needed.
9. timestamp is local to video_id. Do not convert to a concatenated timeline.
10. Ranges inside one video_id must not overlap.
11. Item 1 MUST be OST=0 (hook). Never start on original audio.
12. The last 1–2 items MUST be OST=0 voice-over for the closing wrap (host sign-off / "the story ends here"). Never put the wrap on OST=1. Match those lines to a late-story shot that already exists in the subtitles; do not invent timestamps.
13. Total OST=1 duration should approach ${original_sound_ratio}% of summed timestamp durations (not clip count).
14. picture and matching must serve ${drama_genre}.

## Original-audio ratio
- 0%: no OST=1.
- 10-30%: keep only key dialogue, reversals, emotional peaks, signature scenes.
- 40-60%: narration bridges cause-and-effect; original audio carries key scenes.
- 70-90%: original audio leads; narration is hook, transitions, and necessary glue.
- If ratio conflicts with "first clip OST=0", keep the hook, then raise later OST=1 duration.

## Fields
- _id: consecutive from 1
- video_id: from subtitle headers such as "Video 2" → 2
- video_name: filename from that header
- timestamp: "HH:MM:SS,mmm-HH:MM:SS,mmm"
- picture: people, action, emotion, place, key props
- narration: user copy for OST=0; for OST=1 use "ORIG" plus _id with no space, e.g. ORIG5
- OST: 0 voice-over (mute source), 1 original audio only

## Output
Strict complete JSON only. Close every quote, object, and array. Prefer fewer items over truncated JSON.
{"items":[{"_id":1,"video_id":1,"video_name":"1.mp4","timestamp":"00:00:01,000-00:00:06,000","picture":"...","narration":"...","OST":0}]}
"""

REPAIR_SYSTEM = (
    "You repair an invalid film-commentary cut script. Output strict JSON only. "
    "Fix validation errors without inventing plot."
)

REPAIR_TEMPLATE = """# Task
Repair the invalid cut script so it passes validation.

## Title
${drama_name}
## Genre
${drama_genre}
## Spoken language
${narration_language}
## Plot notes
${plot_analysis}
## Subtitles
${subtitle_content}
## Invalid script
${invalid_script}
## Validation errors
${validation_errors}

Keep _id, video_id, video_name, timestamp, OST unless a validation error requires a change.
OST=1 narration must be ORIG plus _id (e.g. ORIG3).
OST=0 narration must use ${narration_language}.
Output {"items":[...]} only.
"""

MIX_PLOT_SYSTEM = (
    "You are a senior short-drama editor. Extract a coherent storyline from subtitles. "
    "Output strict JSON only."
)

MIX_PLOT_TEMPLATE = """# Task
Analyze short-drama subtitles and extract plot points that form a complete watchable mix-cut.

<subtitles>
${subtitle_content}
</subtitles>

Need ${custom_clips} plot points.

Narrative stages: Setup, Rising Action, Climax, Resolution.
Coherence first: adjacent beats must connect so a viewer understands what happened.
Cover setup, rising action, climax; include resolution if present.
Prefer strong emotion, conflict, and visual impact.
Keep chronological order and cause-and-effect.

Output JSON only:
{
  "summary": "100-200 word overview",
  "narrative_structure": {
    "setup": "...",
    "rising_action": "...",
    "climax": "...",
    "resolution": "..."
  },
  "plot_titles": ["[Setup] ...", "[Rising] ...", "[Climax] ..."],
  "plot_connections": ["beat1 -> beat2 ..."],
  "analysis_details": {
    "main_characters": ["..."],
    "core_conflict": "...",
    "story_theme": "...",
    "emotional_arc": "..."
  }
}

Do not invent plot. Subtitles only.
"""

MIX_SCRIPT_SYSTEM = (
    "You are a short-drama mix-cut editor. Output strict JSON only. "
    "Select real original-audio clips from subtitles. Do not write voice-over copy."
)

MIX_SCRIPT_TEMPLATE = """# Task
Build a mix-cut JSON for "${drama_name}" from plot notes and subtitles.
This is mix-cut, not commentary: no voice-over essay. Every clip keeps original audio (OST=1).

## Genre
${drama_genre}

## Clip count
${custom_clips}

## Plot notes
${plot_analysis}

## Subtitles
${subtitle_content}

## Selection rules
1. Choose ${custom_clips} clips forming setup -> rising conflict -> climax/reversal -> suspense or stage result.
2. Only use video ids, filenames, and time ranges that exist in the subtitles.
3. timestamp is local to video_id: "HH:MM:SS,mmm-HH:MM:SS,mmm".
4. No overlapping ranges inside one video_id. Prefer chronological order inside a file.
5. Prefer key dialogue, identity reveals, emotional peaks, reversals, and causal context.
6. Each clip 5-45 seconds. Do not cut 1-2 second isolated lines or long filler.
7. If two beats jump too far, keep a contextual span rather than a hard punch-in.
8. picture describes people, action, emotion, place, and story function.
9. narration must be ORIG plus _id with no space, e.g. ORIG3.
10. OST must be 1.

Output:
{"items":[{"_id":1,"video_id":1,"video_name":"1.mp4","timestamp":"00:00:01,000-00:00:12,500","picture":"...","narration":"ORIG1","OST":1}]}
"""


def fill(template: str, **values: Any) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("${" + key + "}", str(value if value is not None else ""))
    return out
