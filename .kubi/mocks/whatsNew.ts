// Bare, so it runs first: the real module reads __LINES_CHANGELOG__ and
// __LINES_VERSION__ as it loads (see ./viteDefines).
import './viteDefines';

export * from '../../web/src/lib/whatsNew';
