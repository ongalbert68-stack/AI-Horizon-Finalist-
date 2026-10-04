"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileText, Home, Hourglass, LifeBuoy, NotebookPen } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";

import { ArtifactPanel, type Artifacts } from "@/components/wizard/artifact-panel";
import { ChatPanel } from "@/components/wizard/chat-panel";
import { NotesDrawer } from "@/components/wizard/notes-drawer";
import {
  DONT_KNOW_VALUE, nextId, OTHER_VALUE, UNMAPPED_VALUE,
  type ChatAction, type ChatMessage, type ChipOption, type PendingPrompt,
} from "@/components/wizard/chat-types";
import { StageBar, type Phase } from "@/components/wizard/stage-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, ApiError } from "@/lib/api/client";
import { getCheckPlans } from "@/lib/api/causes";
import { createCheckResult, getCase } from "@/lib/api/cases";
import { updateCase } from "@/lib/api/cases";
import { getFollowupBank, getIntakeSpec, getNextFollowup, mapFreeText } from "@/lib/api/intake";
import { rankCase } from "@/lib/api/ranking";
import { getPrecedents } from "@/lib/api/retrieval";
import { closeCase, getReport, verifyCase } from "@/lib/api/report";
import { analysePhoto } from "@/lib/api/vision";
import type {
  Case, CheckStep, CoarseMatch, Fingerprint, FingerprintAxes, NextFollowUp, Question, Ranking, Verification,
  VisionResult,
} from "@/lib/api/types";
import { becauseClause, shortCause } from "@/lib/sources";

/** The ranking in words, led by *why* — the brief asks for the reason
 * behind the top cause ("ranked highest because the volume changes
 * occasionally rather than continuously"), not just its percentage. */
function describeRanking(ranking: Ranking): string {
  const top = ranking.pass1[0];
  const why = becauseClause(top.evidence);
  // T4 names no lead, so its reasons are the rule engine's, not the verdict's.
  const lead = !why
    ? ""
    : ranking.tier === "T4"
      ? `The rule engine favours ${shortCause(top.label).toLowerCase()} because: ${why}.\n\n`
      : `${shortCause(top.label)} leads because: ${why}.\n\n`;
  const verdict = describeTier(ranking);
  return why && ranking.pass1.some((c) => c.evidence.length > 0) ? lead + verdict : verdict;
}

function describeTier(ranking: Ranking): string {
  const top = ranking.pass1[0];
  const pct = Math.round(top.likelihood * 100);
  // Nothing fired at all: every cause sits on the shared prior, and the
  // "lead" would just be whichever one the vocabulary lists first. Saying
  // so is the honest output — DESIGN.md's own argument for T4 applies
  // here too.
  if (ranking.tier === "T2" && ranking.pass1.every((c) => c.evidence.length === 0)) {
    return (
      "No cause is ahead: nothing you told me, and nothing in the photo, matches any of " +
      "the rules in the tree — so all seven candidates are sitting on the same starting " +
      "odds. That usually means the defect is real but outside what this tree models. A " +
      "troubleshooting check is the fastest way forward, and it's worth telling an " +
      "engineer the list came up empty."
    );
  }
  const headline: Record<Ranking["tier"], string> = {
    T1: `Tier T1 — a clear lead: ${top.label} at ${pct}%.`,
    T2: `Tier T2 — a likely lead: ${top.label} at ${pct}%.`,
    T3: `Tier T3 — ${top.label} at ${pct}%, but a second, independent read disagrees.`,
    T4: `No lead cause yet — the rule engine says ${top.label} at ${pct}%, but a second, independent read disagrees.`,
  };
  // Rankings stored before the reason was recorded fall back to the
  // panel, which shows the gates it rests on.
  return `${headline[ranking.tier]} ${ranking.tier_reason ?? "See the panel on the right for why."}`;
}

/** The measured signals in the words an operator uses. */
const SIGNAL_WORDS: Record<string, string> = {
  size_cv: "size spread",
  missing_count: "missing deposits",
  irregular_count: "irregular deposits",
  small_then_big_chance_p: "small-then-big pattern",
};

function signalValue(signal: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (signal === "size_cv") return value.toFixed(2);
  if (signal === "small_then_big_chance_p") return `p=${value.toFixed(2)}`;
  return String(value);
}

/** The re-measurement in one sentence: the signal that was out before,
 * where it is now, and anything else the photo still finds out of spec —
 * "in spec" covers everything a photo can check, not one number. */
function describeVerification(v: Verification): string {
  if (v.after === null) {
    return "Couldn't measure the verification photo — retake it if you want this case to close CONFIRMED.";
  }
  const words = SIGNAL_WORDS[v.signal ?? "size_cv"] ?? v.signal ?? "size spread";
  const change = `${words} ${signalValue(v.signal ?? "", v.before)} → ${signalValue(v.signal ?? "", v.after)}`;
  const counted = v.deposits_measured ? `Re-measured ${v.deposits_measured} deposits: ` : "Re-measured: ";
  if (v.in_spec) return `${counted}${change}. Everything the photo can check is back in spec.`;
  const failed = (v.checks ?? []).filter((c) => !c.ok).map((c) => SIGNAL_WORDS[c.signal] ?? c.signal);
  return `${counted}${change}. Still out of spec: ${failed.join(", ") || words}.`;
}

/** The sentinel behind "Something else — I'll describe my own check" at the
 * cause step. Never sent: it drops `cause_id` from the draft, and the check
 * is logged with a null cause.
 *
 * A check filed against no cause is recorded on the case and shown in the
 * loop log, but it moves nothing in the ranking — the re-rank only folds in
 * outcomes whose `cause_id` is one of the ranked causes (see
 * ranking/service.py `_apply_check_results`). That's the honest behaviour,
 * and the chip says so rather than letting the operator find out by
 * watching the bars not move. */
const OWN_CHECK_VALUE = "__own_check__";

/** The loop prompt's "I'm stuck" chip. Leads to the same question as the
 * step bar's "Ask an engineer" button. */
const ESCALATE_VALUE = "__escalate__";

const LOOP_PROMPT = "Want to log a troubleshooting check, or move on to the report?";

/** One-tap answers to "What are you stuck on?" — the three ways the loop
 * actually runs out on a shop floor. Typing your own still works. */
const STUCK_REASONS: ChipOption[] = [
  { value: "I don't know which check to run next", label: "I don't know which check to run next" },
  { value: "The checks don't match what I'm seeing", label: "The checks don't match what I'm seeing" },
  { value: "Nothing I've tried has fixed it", label: "Nothing I've tried has fixed it" },
];

/** "Don't know" and "Other (describe)" are appended to every axis from
 * `has_dont_know` / `has_other`, which the API has always reported and
 * the UI used to ignore — leaving no way to answer a question the
 * operator genuinely can't, so the only way forward was a guess that
 * then entered the fingerprint as fact. */
function toChips(q: Question, opts: { includeEscapes?: boolean } = {}): ChipOption[] {
  const chips: ChipOption[] = q.options.map((o) => ({
    value: o.value, label: o.label, helpText: o.help_text, exclusive: o.exclusive,
  }));
  if (opts.includeEscapes === false) return chips;
  if (q.has_dont_know) {
    chips.push({
      value: DONT_KNOW_VALUE, label: "Don't know",
      helpText: "adds no evidence — better than a guess", exclusive: true,
    });
  }
  if (q.has_other) {
    chips.push({
      value: OTHER_VALUE, label: "Other (describe)…",
      helpText: "say it in your own words", exclusive: true,
    });
  }
  return chips;
}

/** The step of a cause's plan with this name, if it is one. Module-level,
 * like toChips: declared inside the component after runStep, which uses it,
 * it made the React Compiler reject the mount effect. */
function plannedStep(
  plans: Record<string, CheckStep[]>, causeId: string | undefined, name: string | undefined,
): CheckStep | undefined {
  if (!causeId || !name) return undefined;
  return (plans[causeId] ?? []).find((step) => step.name === name);
}

/** Which axis question is still unanswered, in interview order — `null`
 * once all five are in. Used both to resume mid-interview after a reload
 * and (implicitly) to know when the interview is complete. */
function nextUnansweredAxis(axes: FingerprintAxes | undefined):
  | "ask_signature" | "ask_trajectory" | "ask_footprint" | "ask_inputs" | "ask_response" | null {
  if (!axes || axes.signature.length === 0) return "ask_signature";
  if (!axes.trajectory) return "ask_trajectory";
  if (!axes.footprint) return "ask_footprint";
  if (axes.inputs.length === 0) return "ask_inputs";
  if (!axes.response) return "ask_response";
  return null;
}

type StepId =
  | "intro" | "ask_photo" | "analyse_photo"
  | "ask_signature" | "ask_trajectory" | "ask_footprint" | "ask_inputs" | "ask_response"
  | "ask_axis_other" | "save_fingerprint" | "ask_followup" | "retrieve_coarse" | "rank" | "loop_prompt"
  | "loop_check_name" | "loop_check_cause" | "loop_check_kind" | "loop_check_outcome"
  | "loop_check_detail" | "loop_submit"
  | "report" | "verify_prompt" | "ask_verify_shots" | "verify_photo"
  | "close_prompt" | "close" | "done";

/** Mirrors cases/close.py's MIN_SHOTS_HELD. Duplicated rather than fetched
 * because it only ever appears in the wording of the question — the close
 * decision itself is made server-side against the real constant. */
const MIN_SHOTS_HELD = 20;

const INTERVIEW_HINT = "Answer on the left. Five questions, and \"Don't know\" is a real answer.";

const STAGE_HINTS: Record<StepId, Phase> = {
  intro: { n: 1, label: "Photo", hint: "Getting the case set up…" },
  // The photo is asked first: it measures the things an operator is worst
  // at eyeballing, it's one tap, and it's the only evidence that can
  // clear Gate A's chance test — so asking it last meant every case was
  // ranked without it (DESIGN.md W3's "skip what the photo answers").
  ask_photo: { n: 1, label: "Photo", hint: "A photo of the deposits measures the defect for you, and fills in the first question. Optional — skip it and we'll just ask." },
  analyse_photo: { n: 1, label: "Photo", hint: "Measuring the deposits…" },
  ask_signature: { n: 2, label: "Interview", hint: INTERVIEW_HINT },
  ask_trajectory: { n: 2, label: "Interview", hint: INTERVIEW_HINT },
  ask_footprint: { n: 2, label: "Interview", hint: INTERVIEW_HINT },
  ask_inputs: { n: 2, label: "Interview", hint: INTERVIEW_HINT },
  ask_response: { n: 2, label: "Interview", hint: INTERVIEW_HINT },
  ask_axis_other: { n: 2, label: "Interview", hint: "Describe it in your own words — we'll file it against the closest option, or keep it as-is." },
  save_fingerprint: { n: 2, label: "Interview", hint: "Saving your answers…" },
  ask_followup: {
    n: 2, label: "Interview",
    hint: "A follow-up, picked for this case — asked only because its answer can change the ranking.",
  },
  retrieve_coarse: { n: 2, label: "Interview", hint: "Checking for similar past cases…" },
  rank: { n: 3, label: "Ranking", hint: "Comparing candidate causes against your answers and the photo." },
  loop_prompt: { n: 4, label: "Troubleshooting", hint: "Log a check to test the top candidate cause, or move straight to the report if you're confident." },
  loop_check_cause: { n: 4, label: "Troubleshooting", hint: "Pick which candidate cause you want to test, or describe a check of your own." },
  loop_check_name: { n: 4, label: "Troubleshooting", hint: "Look at something first if you can — it costs nothing and doesn't spend the one change the case is allowed." },
  loop_check_kind: { n: 4, label: "Troubleshooting", hint: "Did you change anything, or only look? Only changes are counted against the case." },
  loop_check_outcome: { n: 4, label: "Troubleshooting", hint: "Say what happened — this re-ranks the causes." },
  loop_check_detail: { n: 4, label: "Troubleshooting", hint: "Add any detail worth keeping, or leave it blank." },
  loop_submit: { n: 4, label: "Troubleshooting", hint: "Logging the check and re-ranking…" },
  report: { n: 5, label: "Report", hint: "Compiling the findings…" },
  verify_prompt: { n: 5, label: "Report", hint: "Optionally attach a fresh photo to confirm the fix held, or skip straight to closing." },
  ask_verify_shots: { n: 5, label: "Report", hint: "How long did the fix hold? Only you know this — the photo can't tell us." },
  verify_photo: { n: 5, label: "Report", hint: "Re-measuring from the new photo…" },
  close_prompt: { n: 6, label: "Close", hint: "Confirm to close the case and record the outcome." },
  close: { n: 6, label: "Close", hint: "Closing the case…" },
  done: { n: 6, label: "Close", hint: "Case closed — see the summary on the right." },
};

export default function CaseWizardPage() {
  const params = useParams<{ id: string }>();
  const caseId = Number(params.id);
  /** The printable report, opened from here: its back link returns here. */
  const reportHref = `/cases/${caseId}/report?from=wizard`;

  const [loading, setLoading] = React.useState(true);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [pending, setPending] = React.useState<PendingPrompt>({ kind: "none" });
  const [busy, setBusy] = React.useState(false);
  const [artifacts, setArtifacts] = React.useState<Artifacts | null>(null);
  const [phase, setPhase] = React.useState<Phase>(STAGE_HINTS.intro);

  const questionsRef = React.useRef<Question[]>([]);
  const axesRef = React.useRef<Partial<FingerprintAxes>>({});
  /** Raw "Other (describe)" words per axis, kept whether or not the W7
   * mapper could place them on a real option. */
  const axisNotesRef = React.useRef<Record<string, string>>({});
  /** Answers to adaptive follow-ups, keyed by question id. */
  const followupsRef = React.useRef<Record<string, string>>({});
  /** Every follow-up question, for labelling answers on file. */
  const followupBankRef = React.useRef<Question[]>([]);
  /** Each cause's troubleshooting plan, from the same list the report
   * recommends from. Empty if it couldn't load: the loop then asks for the
   * check in the operator's own words. */
  const checkPlansRef = React.useRef<Record<string, CheckStep[]>>({});
  /** The follow-up currently on screen. */
  const pendingFollowupRef = React.useRef<NextFollowUp | null>(null);
  /** Which axis the pending free-text answer belongs to. */
  const otherAxisRef = React.useRef<string | null>(null);
  const draftCheckRef = React.useRef<{
    check_name?: string; cause_id?: string; outcome?: string; is_change?: boolean;
  }>({});
  const artifactsRef = React.useRef<Artifacts | null>(null);
  const currentStepRef = React.useRef<StepId>("intro");
  /** The verification photo, held between attaching it and answering how
   * many shots it held for. */
  const verifyFileRef = React.useRef<File | null>(null);
  /** Set while the operator is saying what they're stuck on. Escalating is
   * a detour, not a pipeline step: it can start from any step, and this
   * holds where to put them back afterwards. */
  const escalationRef = React.useRef<{
    step: StepId; pending: PendingPrompt; phase: Phase; prompt: string | null;
  } | null>(null);
  /** Mirrors escalationRef for rendering: the step bar's button reads it. */
  const [escalating, setEscalating] = React.useState(false);
  /** The engineer-notes drawer: open from the header at any step, and
   * from "Answer & mark reviewed" while a question is waiting. */
  const [notesOpen, setNotesOpen] = React.useState(false);
  const closeNotes = React.useCallback(() => setNotesOpen(false), []);

  function setStage(step: StepId) {
    currentStepRef.current = step;
    setPhase(STAGE_HINTS[step]);
  }

  function say(text: string, actions?: ChatAction[]) {
    setMessages((prev) => [...prev, { id: nextId(), role: "bot", text, actions }]);
  }
  function echo(text: string) {
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
  }
  function patchArtifacts(patch: Partial<Artifacts>) {
    setArtifacts((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      artifactsRef.current = next;
      return next;
    });
  }

  /** Saves whatever's in axesRef so far — fired after every answer, not
   * just at the end of the interview, so a reload mid-interview resumes
   * instead of losing the answers already given. Best-effort: a failure
   * here just means the next answer (or the final save) retries it. */
  async function persistAxes(caseId: number) {
    try {
      const fingerprint: Fingerprint = {
        axes: {
          signature: axesRef.current.signature ?? [],
          trajectory: axesRef.current.trajectory ?? null,
          footprint: axesRef.current.footprint ?? null,
          inputs: axesRef.current.inputs ?? [],
          response: axesRef.current.response ?? null,
        },
        signals: {},
        axis_notes: { ...axisNotesRef.current },
        followups: { ...followupsRef.current },
      };
      await updateCase(caseId, { fingerprint });
      patchArtifacts({
        axes: { ...axesRef.current }, axisNotes: { ...axisNotesRef.current },
        followups: { ...followupsRef.current },
      });
    } catch {
      // best-effort — see comment above
    }
  }

  async function runStep(step: StepId, caseData: Case, arg?: unknown) {
    setStage(step);
    switch (step) {
      case "intro": {
        say(
          `Opened case #${caseData.case_id} on ${caseData.station.name}, running ${caseData.profile.name} ` +
            `(${caseData.profile.material.name}). Let's find out what's wrong.`,
        );
        return runStep("ask_photo", caseData);
      }

      case "ask_photo": {
        say(
          "First: can you photograph the deposits? It measures the size spread, shape and any " +
            "missing dots, and answers the first question for you. Skip it if you can't — " +
            "everything still runs on the answers alone.",
        );
        setPending({ kind: "photo-or-skip", skipLabel: "Skip — no photo" });
        return;
      }

      case "analyse_photo": {
        const file = arg as File;
        setBusy(true);
        try {
          const url = URL.createObjectURL(file);
          patchArtifacts({ photoUrl: url });
          echo(`[attached ${file.name}]`);
          say("Measuring…");
          const vision = await analysePhoto(caseData.case_id, file);
          patchArtifacts({ vision });
          say(
            vision.quality_ok
              ? `Measured it — the deviation is ${vision.magnitude}.`
              : `Couldn't measure it reliably: ${vision.quality_reason} Continuing on the answers alone.`,
          );
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not analyse the photo.");
        } finally {
          setBusy(false);
        }
        return runStep("ask_signature", caseData);
      }

      case "ask_signature": {
        const q = questionsRef.current.find((x) => x.id === "signature")!;
        // What the photo measured, pre-ticked for the operator to confirm
        // or correct. Confirming costs one tap; disagreeing is itself
        // evidence, which is why the measurement is never just written in.
        const suggested = artifactsRef.current?.vision?.suggested_signature ?? [];
        const preselected = suggested.filter((v) => q.options.some((o) => o.value === v));
        say(
          preselected.length > 0
            ? `${q.prompt}\n\nI've ticked what the photo measured — change it if that's not what you see.`
            : q.prompt,
        );
        setPending({
          kind: "chips-multi", options: toChips(q), maxPicks: q.max_picks ?? undefined,
          confirmLabel: preselected.length > 0 ? "That's right" : "Confirm",
          preselected,
        });
        return;
      }
      case "ask_trajectory": {
        const q = questionsRef.current.find((x) => x.id === "trajectory")!;
        say(q.prompt);
        setPending({ kind: "chips-single", options: toChips(q) });
        return;
      }
      case "ask_footprint": {
        const q = questionsRef.current.find((x) => x.id === "footprint")!;
        say(q.prompt);
        setPending({ kind: "chips-single", options: toChips(q) });
        return;
      }
      case "ask_inputs": {
        const q = questionsRef.current.find((x) => x.id === "inputs")!;
        say(q.prompt);
        setPending({ kind: "chips-multi", options: toChips(q), confirmLabel: "Confirm" });
        return;
      }
      case "ask_response": {
        const q = questionsRef.current.find((x) => x.id === "response")!;
        say(q.prompt);
        setPending({ kind: "chips-single", options: toChips(q) });
        return;
      }

      case "ask_axis_other": {
        const axisId = otherAxisRef.current;
        const q = axisId ? questionsRef.current.find((x) => x.id === axisId) : undefined;
        say(q ? `In your own words: ${q.prompt.toLowerCase()}` : "Describe it in your own words.");
        setPending({
          kind: "text", placeholder: "e.g. it leaves a hair between the pads",
          confirmLabel: "Next", multiline: true,
        });
        return;
      }

      case "save_fingerprint": {
        setBusy(true);
        try {
          await persistAxes(caseData.case_id);
          say("Recorded.");
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not save the answers.");
        } finally {
          setBusy(false);
        }
        return runStep("ask_followup", caseData);
      }

      // Not a fixed sixth question: the backend runs every answer to every
      // follow-up through the rule engine and returns the one whose answer
      // would move this case's ranking most — or nothing, when no answer
      // would. The reason is said out loud, so the operator knows why.
      case "ask_followup": {
        setBusy(true);
        let next: NextFollowUp | null = null;
        try {
          next = await getNextFollowup(caseData.case_id);
        } catch {
          next = null; // a follow-up is a bonus; never block the case on one
        } finally {
          setBusy(false);
        }
        if (!next) return runStep("retrieve_coarse", caseData);
        pendingFollowupRef.current = next;
        say(`${next.question.prompt}\n\n${next.reason}`);
        setPending({ kind: "chips-single", options: toChips(next.question) });
        return;
      }

      case "retrieve_coarse": {
        setBusy(true);
        try {
          const matches = await apiRequest<CoarseMatch[]>(`/cases/${caseData.case_id}/retrieval/coarse`);
          patchArtifacts({ coarse: matches });
          // The same matches, tallied by what they were diagnosed as.
          // Best-effort and separate from the ranking on purpose — it is
          // shown as context and feeds nothing.
          try {
            const precedents = await getPrecedents(caseData.case_id);
            patchArtifacts({ precedents });
            if (precedents.sentence) say(precedents.sentence);
          } catch {
            // no history endpoint or no history — the panel just stays empty
          }
          // Says what it matched on, and claims nothing else: this step
          // orders the interview and reads past cases. It does not feed
          // the ranking, and it does not pre-load the checklist — the
          // loop's suggestions come from the cause's own cited remedies.
          say(
            matches.length === 0
              ? "No similar past cases on file yet."
              : `Found ${matches.length} similar past case(s), matching on ` +
                `${[...new Set(matches.flatMap((m) => m.matched_axes))].join(", ")} — ` +
                "listed on the right. They don't move the ranking.",
          );
        } catch {
          patchArtifacts({ coarse: [] });
        } finally {
          setBusy(false);
        }
        return runStep("rank", caseData);
      }

      case "rank": {
        setBusy(true);
        say("Ranking causes…");
        try {
          const ranking = await rankCase(caseData.case_id);
          patchArtifacts({ ranking });
          say(describeRanking(ranking));
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not rank causes.");
        } finally {
          setBusy(false);
        }
        return runStep("loop_prompt", caseData);
      }

      case "loop_prompt": {
        // T4 names no cause, and a T2 where no rule fired has nothing to
        // go on — the two rankings that leave an operator without a next
        // move, so the escalation is spelled out there.
        const ranking = artifactsRef.current?.ranking;
        const noLead =
          ranking?.tier === "T4" ||
          (ranking?.tier === "T2" && ranking.pass1.every((c) => c.evidence.length === 0));
        const escalated = artifactsRef.current?.caseData.escalate ?? false;
        say(
          noLead && !escalated
            ? "Log a check to test one of the candidates, or if you're not sure which check to " +
                "run, ask a senior engineer. You can also move on to the report."
            : LOOP_PROMPT,
        );
        setPending({
          kind: "confirm",
          options: [
            { value: "log", label: "Log a check" },
            { value: "report", label: "Continue to report" },
            ...(escalated ? [] : [{ value: ESCALATE_VALUE, label: "I'm stuck — ask an engineer" }]),
          ],
        });
        return;
      }

      case "loop_check_cause": {
        const ranking = artifactsRef.current?.ranking;
        // Every ranked cause, not just the top four: the list is ordered by
        // likelihood, and hiding the tail meant the only way to test a
        // long-shot was to not log the check at all.
        const options: ChipOption[] = (ranking?.pass1 ?? []).map((c, i) => ({
          value: c.cause_id,
          label: c.label,
          helpText: `${Math.round(c.likelihood * 100)}%${i === 0 ? " · currently ahead" : ""}`,
        }));
        options.push({
          value: OWN_CHECK_VALUE,
          label: "Something else — I'll describe my own check",
          helpText: "logged on the case, but it moves no cause's ranking",
          exclusive: true,
        });
        say(
          "Which candidate cause do you want to test? Or describe your own check — it gets " +
            "logged on the case either way.",
        );
        setPending({ kind: "chips-single", options });
        return;
      }
      case "loop_check_name": {
        const causeId = draftCheckRef.current.cause_id;
        const plan = (causeId ? checkPlansRef.current[causeId] : undefined) ?? [];
        if (plan.length === 0) {
          say(
            causeId
              ? "What did you try, or want to try?"
              : "Describe the check in your own words — what did you do, or what do you want to do?",
          );
        } else {
          // The cause's plan in order, a look before a change, each with
          // what to look for — so the operator knows what they're checking
          // before they check it. Steps already on the case say so.
          const logged = artifactsRef.current?.checks ?? [];
          const changes = logged.filter((c) => c.is_change).length;
          const label = artifactsRef.current?.ranking?.pass1.find((c) => c.cause_id === causeId)?.label ?? causeId;
          const steps = plan.map((step, i) => {
            const done = logged.find((c) => c.check_name === step.name);
            const status = done ? ` — done, ${done.outcome?.replaceAll("_", " ") ?? "logged"}` : "";
            return (
              `Step ${i + 1} · ${step.is_change ? "Change" : "Look"}: ${step.name}${status}\n` +
              `Confirms it if ${step.confirms_if}. Rules it out if ${step.rules_out_if}.`
            );
          });
          const changeNote =
            changes > 0
              ? `The case already has ${changes === 1 ? "one change" : `${changes} changes`}, so another ` +
                "change means it can't close CONFIRMED."
              : "Look first if you can: it costs nothing, and the case can only close CONFIRMED if exactly " +
                "one thing was changed.";
          say(
            `To test ${label?.toLowerCase()}, step by step:\n\n${steps.join("\n\n")}\n\n${changeNote} ` +
              "Pick the step you ran to log what you saw, or describe your own.",
          );
        }
        setPending({
          kind: "text-with-suggestions",
          suggestions: plan.map((step, i) => ({
            value: step.name, label: `Step ${i + 1} · ${step.name}`,
            helpText: step.is_change ? "changes something" : "look only",
          })),
          placeholder: "e.g. purge and re-prime",
          confirmLabel: "Next",
          skipLabel: "Not sure — skip this check",
          multiline: true,
        });
        return;
      }

      case "loop_check_kind": {
        // Only reached for a check the operator typed themselves: the
        // suggestions already declare which of them is a change, so
        // tapping one skips this question entirely.
        say("Did that change anything on the machine, or did you only look?");
        setPending({
          kind: "chips-single",
          options: [
            { value: "observe", label: "Only looked", helpText: "nothing altered — costs the case nothing" },
            { value: "change", label: "I changed something", helpText: "tooling, material, pressure, program…" },
          ],
        });
        return;
      }
      case "loop_check_outcome": {
        const step = plannedStep(checkPlansRef.current, draftCheckRef.current.cause_id, draftCheckRef.current.check_name);
        say(step ? "What did you see?" : "What happened?");
        setPending({
          kind: "chips-single",
          options: [
            { value: "confirms", label: "Confirms it", helpText: step?.confirms_if },
            { value: "rules_out", label: "Rules it out", helpText: step?.rules_out_if },
            { value: "inconclusive", label: "Inconclusive", helpText: step ? "neither — it moves nothing" : undefined },
          ],
        });
        return;
      }
      case "loop_check_detail": {
        say("Any detail worth recording? (optional)");
        setPending({
          kind: "text",
          placeholder:
            "e.g. air slug expelled\n\nParagraphs are fine — paste the full observation if you have one.",
          confirmLabel: "Log it", allowEmpty: true, multiline: true,
        });
        return;
      }
      case "loop_submit": {
        setBusy(true);
        try {
          const detail = arg as string;
          const causeId = draftCheckRef.current.cause_id ?? null;
          const updated = await createCheckResult(caseData.case_id, {
            check_name: draftCheckRef.current.check_name!,
            cause_id: causeId,
            cost_minutes: null, invasive: false, safety_note: null,
            is_change: draftCheckRef.current.is_change ?? false,
            outcome: draftCheckRef.current.outcome as "confirms" | "rules_out" | "inconclusive",
            result_detail: detail || null,
          });
          const refreshed = await getCase(caseData.case_id);
          const tierBefore = artifactsRef.current?.ranking?.tier;
          patchArtifacts({ ranking: updated, checks: refreshed.check_results, caseData: refreshed });
          // A check is the one thing that can settle the tier on its own,
          // so a change of tier is said out loud rather than left to the panel.
          const tierNote =
            tierBefore && tierBefore !== updated.tier && updated.tier_reason
              ? ` Now ${updated.tier}: ${updated.tier_reason}`
              : "";
          const actionNote =
            refreshed.action_count === 1
              ? "One change on the case so far, which is what CONFIRMED needs."
              : refreshed.action_count === 0
                ? "Nothing changed yet, so nothing is spent."
                : `${refreshed.action_count} changes on the case now — it can't close CONFIRMED.`;
          say(
            causeId
              ? `Logged — re-ranked. Top candidate now: ${updated.pass1[0].label} at ` +
                  `${Math.round(updated.pass1[0].likelihood * 100)}%.${tierNote} ${actionNote}`
              : // No cause to fold the outcome into, so the ranking is
                // untouched. Saying "re-ranked" here would claim an update
                // the operator can see didn't happen.
                "Logged on the case. It isn't tied to one of the ranked causes, so the ranking is " +
                  `unchanged — still ${updated.pass1[0].label} at ` +
                  `${Math.round(updated.pass1[0].likelihood * 100)}%. ${actionNote}`,
          );
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not log the check.");
        } finally {
          setBusy(false);
          draftCheckRef.current = {};
        }
        return runStep("loop_prompt", caseData);
      }

      case "report": {
        setBusy(true);
        say("Compiling the report…");
        try {
          const report = await getReport(caseData.case_id, true);
          patchArtifacts({ report });
          say(report.explanation ?? "Report ready — see the panel.", [
            { href: reportHref, label: "Open the printable report" },
          ]);
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not compile the report.");
        } finally {
          setBusy(false);
        }
        setStage("verify_prompt");
        say("Want to verify the fix with a fresh photo?");
        setPending({ kind: "photo-or-skip", skipLabel: "Skip verification" });
        return;
      }

      // The photo measures whether it came back in spec; it cannot say how
      // long it held. That was hardcoded to 30 — above the 20-shot bar —
      // so step 8's fifth condition passed itself the moment any photo was
      // attached, and "held for the next N shots" was never asked of
      // anyone. It is asked now, and a short run is allowed to fail it.
      case "ask_verify_shots": {
        verifyFileRef.current = arg as File;
        say(
          "How many shots did you run after the change, with the defect staying away? " +
            `A case needs at least ${MIN_SHOTS_HELD} clean shots to close CONFIRMED — ` +
            "fewer is fine, it just closes lower.",
        );
        setPending({
          kind: "chips-single",
          options: [
            { value: "5", label: "About 5", helpText: `short of the ${MIN_SHOTS_HELD}-shot bar` },
            { value: "10", label: "About 10", helpText: `short of the ${MIN_SHOTS_HELD}-shot bar` },
            { value: "20", label: "About 20", helpText: "meets the bar" },
            { value: "50", label: "50 or more", helpText: "a full run" },
          ],
        });
        return;
      }

      case "verify_photo": {
        const shots = Number(arg);
        const file = verifyFileRef.current;
        if (!file) return runStep("close_prompt", caseData);
        setBusy(true);
        try {
          const verification = await verifyCase(caseData.case_id, file, shots);
          const currentReport = artifactsRef.current?.report ?? null;
          patchArtifacts({ report: currentReport ? { ...currentReport, verification } : currentReport });
          say(describeVerification(verification));
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not verify.");
        } finally {
          setBusy(false);
        }
        return runStep("close_prompt", caseData);
      }

      case "close_prompt": {
        say("Ready to close the case?");
        setPending({ kind: "confirm", options: [{ value: "close", label: "Close the case" }] });
        return;
      }
      case "close": {
        setBusy(true);
        try {
          const result = await closeCase(caseData.case_id);
          patchArtifacts({ close: result });
          // "Closed" on its own gets read as "fixed". It isn't: the tier is
          // a verdict on what was proved, and only CONFIRMED claims the
          // repair worked — so the message says which one this is.
          say(
            result.gaps.length === 0
              ? `Closed as ${result.tier}. All five conditions were met — the cause was confirmed by a ` +
                  "check, exactly one thing was changed, and the re-measurement came back in spec and held. " +
                  "This case counts as fixed and proved."
              : `Closed as ${result.tier} — that records what was proved, not that it's fixed. ` +
                  `Still open: ${result.gaps.join("; ")}.`,
            [
              { href: reportHref, label: "Open the report" },
              { href: `/cases/${caseData.case_id}`, label: `Back to case #${caseData.case_id}` },
            ],
          );
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not close the case.");
        } finally {
          setBusy(false);
        }
        setStage("done");
        setPending({ kind: "none" });
        // Closing doesn't answer the operator: a reviewer who has just
        // settled the case is asked for the reply while they're here.
        if (artifactsRef.current?.caseData.escalate) {
          say(
            `The operator's question is still waiting: "${caseData.escalation_note ?? "no question given"}". ` +
              "Answer it in the notes and mark the case reviewed.",
            [{ label: "Answer & mark reviewed", onClick: () => setNotesOpen(true) }],
          );
        }
        return;
      }

      default:
        return;
    }
  }

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      getCase(caseId), getIntakeSpec(), getFollowupBank().catch(() => [] as Question[]),
      getCheckPlans().catch(() => ({}) as Record<string, CheckStep[]>),
    ])
      .then(([caseData, questions, followupBank, checkPlans]) => {
        if (cancelled) return;
        questionsRef.current = questions;
        followupBankRef.current = followupBank;
        checkPlansRef.current = checkPlans;
        followupsRef.current = { ...(caseData.fingerprint?.followups ?? {}) };

        const axes = caseData.fingerprint?.axes;
        axesRef.current = axes ? { ...axes } : {};
        axisNotesRef.current = { ...(caseData.fingerprint?.axis_notes ?? {}) };

        // Hydrate from whatever the case already has on file — a reload or
        // a "Continue troubleshooting" link both land here with a case
        // that may already be partway through the pipeline, and the panel
        // (and the resume point below) need to reflect that, not blank.
        // The backend stores a reduced subset onto case.vision_result — the
        // signals it derived live on in fingerprint.signals instead (the
        // canonical place for them), so a resume has to recombine the two
        // rather than casting vision_result straight to VisionResult.
        const storedVision = caseData.vision_result as Omit<VisionResult, "signals" | "small_then_big_above_chance"> | null;
        const numericSignals = Object.fromEntries(
          Object.entries(caseData.fingerprint?.signals ?? {}).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        );
        const vision: VisionResult | null = storedVision
          ? { ...storedVision, signals: numericSignals, small_then_big_above_chance: false }
          : null;

        const initial: Artifacts = {
          caseData, photoUrl: null,
          questions,
          axes: axes ?? {},
          axisNotes: { ...axisNotesRef.current },
          followups: { ...followupsRef.current },
          followupQuestions: followupBank,
          vision,
          coarse: null,
          precedents: null,
          ranking: caseData.ranking,
          comparison: null,
          checks: caseData.check_results,
          report: null,
          close: caseData.tier ? { tier: caseData.tier, gaps: [] } : null,
        };
        artifactsRef.current = initial;
        setArtifacts(initial);
        setLoading(false);

        // Resuming past the retrieval step (or landing on a closed case)
        // skips runStep("retrieve_coarse"), so the history cards would only
        // ever appear on a first run through. Fetch them here too.
        if (axes) {
          void apiRequest<CoarseMatch[]>(`/cases/${caseId}/retrieval/coarse`)
            .then((coarse) => {
              if (!cancelled) patchArtifacts({ coarse });
            })
            .catch(() => {
              // the card stays hidden
            });
          void getPrecedents(caseId)
            .then((precedents) => {
              if (!cancelled) patchArtifacts({ precedents });
            })
            .catch(() => {
              // no history yet — the card stays hidden
            });
        }

        const hasProgress =
          Boolean(caseData.closed_at) || Boolean(caseData.ranking) || Boolean(caseData.vision_result) ||
          Boolean(axes && (axes.signature.length > 0 || axes.trajectory || axes.footprint
            || axes.inputs.length > 0 || axes.response));

        if (!hasProgress) {
          sayEscalationStatus(caseData);
          void runStep("intro", caseData);
          return;
        }

        // Resuming a case that already has something on file. Rather than
        // one generic "you already answered these" line, replay each
        // question/answer pair that's actually on record — the transcript
        // should show your own prior replies, not just the bot's recap of
        // them — then pick up at the first step that isn't already done.
        say(
          `Welcome back to case #${caseData.case_id} on ${caseData.station.name}, running ` +
            `${caseData.profile.name} (${caseData.profile.material.name}).`,
        );

        const axisOrder: { id: "signature" | "trajectory" | "footprint" | "inputs" | "response"; value: string[] | string | undefined }[] = [
          { id: "signature", value: axes?.signature && axes.signature.length > 0 ? axes.signature : undefined },
          { id: "trajectory", value: axes?.trajectory ?? undefined },
          { id: "footprint", value: axes?.footprint ?? undefined },
          { id: "inputs", value: axes?.inputs && axes.inputs.length > 0 ? axes.inputs : undefined },
          { id: "response", value: axes?.response ?? undefined },
        ];
        for (const a of axisOrder) {
          if (a.value === undefined) break; // answered in order — stop at the first gap
          const q = questionsRef.current.find((x) => x.id === a.id);
          if (!q) continue;
          say(q.prompt);
          echo(Array.isArray(a.value) ? a.value.map((v) => labelFor(a.id, v)).join(", ") : labelFor(a.id, a.value));
        }
        for (const [qid, value] of Object.entries(followupsRef.current)) {
          const q = followupBankRef.current.find((x) => x.id === qid);
          if (!q) continue;
          say(q.prompt);
          echo(q.options.find((o) => o.value === value)?.label ?? value);
        }
        // After the replay, not before it: an engineer's reply is the thing
        // the operator came back for, so it lands next to the prompt instead
        // of scrolled up above the old answers.
        sayEscalationStatus(caseData);

        // A closed case is reopened into the loop rather than dead-ended.
        // It used to stop here with "already closed" and no prompt, so
        // every "reopen" affordance on the case page led to a screen that
        // could do nothing. Nothing in the pipeline forbids continuing:
        // check-results still log and re-rank, and close re-scores the
        // case against step 8's five conditions from scratch.
        if (caseData.closed_at) {
          const closedNote = caseData.tier
            ? `This case was closed as ${caseData.tier}.`
            : "This case was closed.";
          say(
            `${closedNote} You can log another check — it re-ranks the causes, and closing again ` +
              "re-scores the case on what's been proved by then.",
          );
          void runStep("loop_prompt", caseData);
          return;
        }
        if (caseData.verification) {
          say("Verification is already on file. Ready to close whenever you are.");
          void runStep("close_prompt", caseData);
          return;
        }
        if (caseData.ranking) {
          const checkNote = caseData.check_results.length > 0
            ? ` ${caseData.check_results.length} check(s) already logged.`
            : "";
          say(`Ranking is already done — tier ${caseData.ranking.tier}.${checkNote} You can log another check or revisit the report.`);
          void runStep("loop_prompt", caseData);
          return;
        }
        // Resume points follow the pipeline's own order, which now runs
        // photo -> interview -> retrieval -> rank.
        const nextAxis = nextUnansweredAxis(axes);
        if (nextAxis === null) {
          void runStep("ask_followup", caseData);
          return;
        }
        if (!caseData.vision_result) {
          say("We never got as far as a photo — want to add one now? It answers the first question for you.");
          setStage("ask_photo");
          setPending({ kind: "photo-or-skip", skipLabel: "Skip — no photo" });
          return;
        }
        say("Picking up where we left off.");
        void runStep(nextAxis, caseData);
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : "Could not load the case."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  /** On opening a case: is someone's question still waiting, or has an
   * engineer answered it? The answer is the engineer notes — the review
   * panel on the case page is where they're written. */
  function sayEscalationStatus(caseData: Case) {
    if (caseData.escalate) {
      say(
        `You asked a senior engineer: "${caseData.escalation_note ?? "no question given"}". ` +
          "Not reviewed yet — carry on if you can.",
      );
    } else if (caseData.escalation_note) {
      say(
        caseData.engineer_notes
          ? `A senior engineer reviewed your question ("${caseData.escalation_note}") and wrote:\n\n${caseData.engineer_notes}`
          : `A senior engineer reviewed your question ("${caseData.escalation_note}") but left no notes.`,
      );
    }
  }

  function startEscalation() {
    if (escalationRef.current || busy) return;
    const lastBot = [...messages].reverse().find((m) => m.role === "bot");
    escalationRef.current = {
      step: currentStepRef.current, pending, phase, prompt: lastBot?.text ?? null,
    };
    setEscalating(true);
    echo("I'm stuck — ask an engineer");
    say(
      "What are you stuck on? One line is enough. A senior engineer sees it under Needs " +
        "review on the home page, and you can keep going while you wait.",
    );
    setPhase({ ...phase, hint: "Say what you're stuck on, or cancel to go back." });
    setPending({
      kind: "text-with-suggestions", suggestions: STUCK_REASONS,
      placeholder: "Or describe it in your own words", confirmLabel: "Send", skipLabel: "Cancel",
    });
  }

  /** Back to wherever the operator was, with the question they were on
   * asked again — it has scrolled up out of sight by now. Once sent, the
   * loop prompt loses its "I'm stuck" chip and the line suggesting it. */
  function endEscalation(sent: boolean) {
    const from = escalationRef.current;
    escalationRef.current = null;
    setEscalating(false);
    if (!from) return;
    let { pending: restored, prompt } = from;
    if (sent && from.step === "loop_prompt" && restored.kind === "confirm") {
      restored = { ...restored, options: restored.options.filter((o) => o.value !== ESCALATE_VALUE) };
      prompt = LOOP_PROMPT;
    }
    currentStepRef.current = from.step;
    setPhase(from.phase);
    if (restored.kind !== "none" && prompt) say(prompt);
    setPending(restored);
  }

  async function submitEscalation(caseData: Case, note: string) {
    setBusy(true);
    let sent = false;
    try {
      const updated = await updateCase(caseData.case_id, { escalate: true, escalation_note: note });
      patchArtifacts({ caseData: updated });
      sent = true;
      say(
        `Sent. Case #${caseData.case_id} is now under Needs review. When an engineer answers, ` +
          "their reply shows here the next time you open this case.",
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send it to an engineer.");
    } finally {
      setBusy(false);
    }
    endEscalation(sent);
  }

  function requireCase(): Case | null {
    return artifactsRef.current?.caseData ?? null;
  }

  /** The single-select axes, in interview order, with where each one goes
   * next. Kept as data so "Other (describe)" can bounce out to a text
   * prompt and come back to the right place. */
  const SINGLE_AXIS_FLOW: Record<string, { axis: "trajectory" | "footprint" | "response"; next: StepId }> = {
    ask_trajectory: { axis: "trajectory", next: "ask_footprint" },
    ask_footprint: { axis: "footprint", next: "ask_inputs" },
    ask_response: { axis: "response", next: "save_fingerprint" },
  };

  function handleChipSingle(value: string) {
    const caseData = requireCase();
    if (!caseData) return;
    const step = currentStepRef.current;

    const single = SINGLE_AXIS_FLOW[step];
    if (single) {
      if (value === OTHER_VALUE) {
        otherAxisRef.current = single.axis;
        echo("Other (describe)…");
        void runStep("ask_axis_other", caseData);
        return;
      }
      axesRef.current[single.axis] = value;
      echo(labelFor(single.axis, value));
      void persistAxes(caseData.case_id);
      void runStep(single.next, caseData);
      return;
    }

    if (step === "ask_followup") {
      const followup = pendingFollowupRef.current;
      if (!followup) return;
      pendingFollowupRef.current = null;
      followupsRef.current = { ...followupsRef.current, [followup.question.id]: value };
      echo(followup.question.options.find((o) => o.value === value)?.label ?? value);
      // Saved before asking again: the next pick has to see this answer.
      void persistAxes(caseData.case_id).then(() => runStep("ask_followup", caseData));
      return;
    }

    if (step === "loop_check_kind") {
      draftCheckRef.current.is_change = value === "change";
      echo(value === "change" ? "I changed something" : "Only looked");
      void runStep("loop_check_outcome", caseData);
      return;
    }
    if (step === "loop_prompt") {
      if (value === ESCALATE_VALUE) {
        startEscalation();
        return;
      }
      echo(value === "log" ? "Log a check" : "Continue to report");
      void runStep(value === "log" ? "loop_check_cause" : "report", caseData);
      return;
    }
    if (step === "loop_check_cause") {
      if (value === OWN_CHECK_VALUE) {
        // No cause_id at all, rather than one picked to have something to
        // send. The backend takes a null cause_id, and a check filed under
        // a cause nobody tested would put fake evidence on that cause.
        draftCheckRef.current.cause_id = undefined;
        echo("Something else — I'll describe my own check");
        void runStep("loop_check_name", caseData);
        return;
      }
      draftCheckRef.current.cause_id = value;
      const label = artifactsRef.current?.ranking?.pass1.find((c) => c.cause_id === value)?.label ?? value;
      echo(label);
      void runStep("loop_check_name", caseData);
      return;
    }
    if (step === "loop_check_outcome") {
      draftCheckRef.current.outcome = value;
      echo(value.replaceAll("_", " "));
      void runStep("loop_check_detail", caseData);
      return;
    }
    if (step === "ask_verify_shots") {
      echo(value === "50" ? "50 or more shots" : `about ${value} shots`);
      void runStep("verify_photo", caseData, value);
      return;
    }
    if (step === "close_prompt") {
      echo("Close the case");
      void runStep("close", caseData);
      return;
    }
  }

  function handleChipsMulti(values: string[]) {
    const caseData = requireCase();
    if (!caseData) return;
    const step = currentStepRef.current;
    const axis = step === "ask_signature" ? "signature" : step === "ask_inputs" ? "inputs" : null;
    if (!axis) return;
    const next: StepId = axis === "signature" ? "ask_trajectory" : "ask_response";

    // "Other" is exclusive, so it can only arrive alone.
    if (values.includes(OTHER_VALUE)) {
      otherAxisRef.current = axis;
      echo("Other (describe)…");
      void runStep("ask_axis_other", caseData);
      return;
    }

    axesRef.current[axis] = values;
    echo(values.map((v) => labelFor(axis, v)).join(", "));
    void persistAxes(caseData.case_id);
    void runStep(next, caseData);
  }

  /** The "Other (describe)" landing: try to place the words on a real
   * option (W7 call-1), and say which one, because an operator who can't
   * see where their words went can't correct it. If it won't map, the
   * words are kept and the axis is marked `unmapped` — retrieval then
   * drops that axis instead of scoring it as a mismatch. */
  async function resolveOtherText(caseData: Case, axisId: string, text: string) {
    axisNotesRef.current = { ...axisNotesRef.current, [axisId]: text };
    const isMulti = axisId === "signature" || axisId === "inputs";
    setBusy(true);
    let mapped: string | null = null;
    try {
      const result = await mapFreeText({ case_id: caseData.case_id, question_id: axisId, text });
      mapped = result.mapped_value;
    } catch {
      mapped = null; // offline or no LLM — fall through to unmapped
    } finally {
      setBusy(false);
    }

    const stored = mapped ?? UNMAPPED_VALUE;
    if (isMulti) axesRef.current[axisId as "signature" | "inputs"] = [stored];
    else axesRef.current[axisId as "trajectory" | "footprint" | "response"] = stored;

    say(
      mapped
        ? `Filed that as "${labelFor(axisId, mapped)}" — your words are kept on the case either way.`
        : "Nothing in the list matches that, so I've kept your words as-is and left this " +
            "question out of the past-case matching rather than guessing.",
    );
    await persistAxes(caseData.case_id);
    otherAxisRef.current = null;

    const nextStep: StepId =
      axisId === "signature" ? "ask_trajectory"
        : axisId === "trajectory" ? "ask_footprint"
          : axisId === "footprint" ? "ask_inputs"
            : axisId === "inputs" ? "ask_response"
              : "save_fingerprint";
    void runStep(nextStep, caseData);
  }

  function handleText(value: string) {
    const caseData = requireCase();
    if (!caseData) return;
    const step = currentStepRef.current;

    if (escalationRef.current) {
      echo(value);
      void submitEscalation(caseData, value);
      return;
    }

    if (step === "ask_axis_other") {
      const axisId = otherAxisRef.current;
      if (!axisId) return;
      echo(value);
      void resolveOtherText(caseData, axisId, value);
      return;
    }
    if (step === "loop_check_name") {
      draftCheckRef.current.check_name = value;
      echo(value);
      // A tapped suggestion already says whether it changes anything;
      // anything typed has to be asked, because guessing it wrong either
      // fabricates a change or hides one, and step 8 rests on the count.
      const suggested = plannedStep(checkPlansRef.current, draftCheckRef.current.cause_id, value);
      if (suggested) {
        draftCheckRef.current.is_change = suggested.is_change;
        void runStep("loop_check_outcome", caseData);
      } else {
        void runStep("loop_check_kind", caseData);
      }
      return;
    }
    if (step === "loop_check_detail") {
      echo(value || "(no detail)");
      void runStep("loop_submit", caseData, value);
      return;
    }
  }

  function handlePhoto(file: File) {
    const caseData = requireCase();
    if (!caseData) return;
    const step = currentStepRef.current;
    if (step === "ask_photo") void runStep("analyse_photo", caseData, file);
    // The photo alone can't say how long the fix held, so that is asked
    // before the re-measurement is sent.
    if (step === "verify_prompt") {
      echo(`[attached ${file.name}]`);
      void runStep("ask_verify_shots", caseData, file);
    }
  }

  function handleSkip() {
    const caseData = requireCase();
    if (!caseData) return;
    const step = currentStepRef.current;
    if (escalationRef.current) {
      echo("Cancel");
      endEscalation(false);
      return;
    }
    if (step === "verify_prompt") {
      echo("Skip verification");
      void runStep("close_prompt", caseData);
    } else if (step === "loop_check_name") {
      echo("Not sure — skip this check");
      draftCheckRef.current = {};
      void runStep("loop_prompt", caseData);
    } else {
      // Photo skipped: straight into the interview, which now has to
      // carry the case on its own.
      echo("Skip — no photo");
      void runStep("ask_signature", caseData);
    }
  }

  function labelFor(axisId: string, value: string): string {
    if (value === DONT_KNOW_VALUE) return "Don't know";
    if (value === UNMAPPED_VALUE) return axisNotesRef.current[axisId] ?? "described in own words";
    const q = questionsRef.current.find((x) => x.id === axisId);
    return q?.options.find((o) => o.value === value)?.label ?? value.replaceAll("_", " ");
  }

  if (loading || !artifacts) {
    return (
      <div className="mx-auto max-w-5xl flex-1 space-y-3 px-6 py-10">
        <Link
          href={`/cases/${caseId}`}
          className={buttonVariants({ variant: "ghost", size: "sm", className: "mb-4 gap-1.5" })}
        >
          <ArrowLeft className="size-4" />
          Case #{caseId}
        </Link>
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      {/* One way back, to the case this wizard is working on: every flow on
          a case returns to its page. The trail through "Past Cases" and the
          second "All Cases" button sent people somewhere else each time. */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b bg-card/80 px-4 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/cases/${caseId}`}
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
            })}
          >
            <ArrowLeft className="size-3.5" />
            <span>Case #{caseId}</span>
          </Link>
          <span className="text-muted-foreground/30">/</span>
          <span className="truncate text-xs font-semibold text-foreground">Troubleshooting</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs"
            onClick={() => setNotesOpen(true)}
            title={artifacts.caseData.engineer_notes ? "Engineer notes are written — read or edit" : "No engineer notes yet"}
          >
            <NotebookPen className="size-3.5" />
            <span className="hidden sm:inline">Notes</span>
            {artifacts.caseData.engineer_notes && (
              <span className="size-1.5 rounded-full bg-primary" aria-label="written" />
            )}
          </Button>
          {/* The report at any point, not only after step 5: someone who
              stops halfway still wants to see what the case has so far. */}
          <Link
            href={reportHref}
            className={buttonVariants({ variant: "outline", size: "sm", className: "h-8 gap-1.5 text-xs" })}
          >
            <FileText className="size-3.5" />
            Report
          </Link>
          <Link
            href="/"
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground",
            })}
            aria-label="Home"
          >
            <Home className="size-3.5" />
            <span className="hidden sm:inline">Home</span>
          </Link>
        </div>
      </header>

      <StageBar
        phase={phase}
        action={
          artifacts.caseData.escalate ? (
            <span className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-xs font-medium text-destructive lg:inline-flex">
                <Hourglass className="size-3.5" />
                Waiting for an engineer
              </span>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNotesOpen(true)}>
                <LifeBuoy className="size-3.5" />
                Answer &amp; mark reviewed
              </Button>
            </span>
          ) : (
            <Button
              variant="outline" size="sm" className="gap-1.5"
              disabled={busy || escalating}
              onClick={startEscalation}
            >
              <LifeBuoy className="size-3.5" />
              Ask an engineer
            </Button>
          )
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-x overflow-hidden md:grid-cols-2">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <ChatPanel
            messages={messages} pending={pending} busy={busy}
            onChipSingle={handleChipSingle} onChipsMulti={handleChipsMulti}
            onText={handleText} onPhoto={handlePhoto} onSkip={handleSkip}
          />
        </div>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <ArtifactPanel artifacts={artifacts} reportHref={reportHref} />
        </div>
      </div>
      <NotesDrawer
        caseData={artifacts.caseData}
        open={notesOpen}
        onClose={closeNotes}
        onCaseChange={(updated) => {
          const wasWaiting = artifactsRef.current?.caseData.escalate;
          patchArtifacts({ caseData: updated });
          if (wasWaiting && !updated.escalate) {
            say("Marked reviewed. The operator sees your notes the next time they open this case.");
          }
        }}
      />
    </div>
  );
}
