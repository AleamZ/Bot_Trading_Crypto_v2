export type SetupState =
  | "WaitingTrend"
  | "TrendConfirmed"
  | "FVGDetected"
  | "WaitingMitigation"
  | "MonitoringLTF"
  | "WaitingCHOCH"
  | "WaitingLtfFvg"
  | "WaitingLtfMitigation"
  | "ReadyToEnter"
  | "PositionOpened"
  | "ManagingTrade"
  | "Closed"
  | "Archived";

const transitions: Record<SetupState, readonly SetupState[]> = {
  WaitingTrend: ["TrendConfirmed"],
  TrendConfirmed: ["FVGDetected"],
  FVGDetected: ["WaitingMitigation"],
  WaitingMitigation: ["MonitoringLTF", "Archived"],
  MonitoringLTF: ["WaitingCHOCH", "Archived"],
  WaitingCHOCH: ["WaitingLtfFvg", "Archived"],
  WaitingLtfFvg: ["WaitingLtfMitigation", "Archived"],
  WaitingLtfMitigation: ["ReadyToEnter", "Archived"],
  ReadyToEnter: ["PositionOpened", "Archived"],
  PositionOpened: ["ManagingTrade"],
  ManagingTrade: ["Closed"],
  Closed: ["Archived"],
  Archived: []
};

export function transitionSetupState(current: SetupState, next: SetupState): SetupState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid setup transition: ${current} -> ${next}`);
  }
  return next;
}
