"use client";

import { Component, ReactNode } from "react";

type Props = {
  children: ReactNode;
  onError: () => void;
};
type State = { hasError: boolean };

export class ChannelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          Redirecting…
        </div>
      );
    }
    return this.props.children;
  }
}
