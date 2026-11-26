declare namespace React {
  type ReactNode = any;
  type ReactElement = any;
  type ChangeEvent<T = any> = {
    target: T & { value: string; files?: FileList | null; checked?: boolean };
    stopPropagation(): void;
  };
  type FormEvent<T = any> = { preventDefault(): void; currentTarget: T };
  type KeyboardEvent<T = any> = { key: string; shiftKey: boolean; preventDefault(): void; currentTarget: T };

  function createElement(type: any, props?: any, ...children: any[]): any;
  function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
  function useRef<T>(initial: T): { current: T };
  function useMemo<T>(factory: () => T, deps: readonly any[]): T;
  const Fragment: any;
}

declare namespace ReactDOM {
  function createRoot(container: Element | null): { render(element: any): void };
  function render(element: any, container: Element | null): void;
}

declare namespace JSX {
  type Element = any;
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
