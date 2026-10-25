// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { Component, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { WorkspacePage } from "../features/workspace/WorkspacePage";
import { Tip } from "../ui/Tip";
import { PermissionsLedgerProvider } from "./PermissionsLedgerContext";
import { AgentsLibraryProvider, HistoryProvider, ThemeProvider } from "./contexts";

function RootLayout() {
  return (
    <div className="root-shell">
      <div className="root-content">
        <Outlet />
      </div>
      <Tip />
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route path="/" element={<WorkspacePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <AgentsLibraryProvider>
        <HistoryProvider>
          <PermissionsLedgerProvider>{children}</PermissionsLedgerProvider>
        </HistoryProvider>
      </AgentsLibraryProvider>
    </ThemeProvider>
  );
}

export function RouterRoot() {
  return (
    <ErrorBoundary>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Providers>
          <AppRoutes />
        </Providers>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="u-centre">
        <div className="u-trust">
          <h4>Something went wrong</h4>
          <p>The page hit an unexpected error. Your agents and saved keys are untouched - reload to carry on.</p>
          <div className="u-trust-actions">
            <button className="u-btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
