// Types minimaux de htm-preact-3.1.1.js (Preact + htm autonome), pour la vérification // @ts-check de public/app.
// Ne couvre que ce que l'appli utilise.
export declare function html(strings: TemplateStringsArray, ...values: any[]): any;
export declare function h(type: any, props: any, ...children: any[]): any;
export declare function render(vnode: any, parent: Element): void;
export declare class Component<P = any, S = any> {
  constructor(props?: P);
  props: P;
  state: S;
  setState(update: Partial<S> | ((state: S, props: P) => Partial<S> | null) | null, callback?: () => void): void;
  forceUpdate(callback?: () => void): void;
}
