//! Lynk on NativeDesktop: a window with the tab sidebar and one Chromium page. The parity
//! checklist and the order of work are in `docs/nd-parity.md` and `docs/nd-port-plan.md`.

use nd::prelude::*;
use nd::webview::{Navigate, TitleChanged, WebView, WebViewOptions, webview};

const HOME: &str = "https://example.com";

struct Tab {
    id: u64,
    page: WebView,
    title: SharedString,
}

pub struct Browser {
    tabs: Vec<Tab>,
    selected: u64,
}

impl Browser {
    fn new(url: &str) -> Self {
        let page = WebView::with_options(WebViewOptions::default().inspectable(true));
        page.load(url);
        Self { tabs: vec![Tab { id: 1, page, title: "New Tab".into() }], selected: 1 }
    }

    fn tab_mut(&mut self, id: u64) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == id)
    }
}

impl Render for Browser {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let items: Vec<SourceItem> =
            self.tabs.iter().map(|t| source_item(t.id.to_string(), t.title.clone()).icon(Icon::Globe)).collect();
        let content = match self.tabs.iter().find(|t| t.id == self.selected) {
            Some(tab) => {
                let id = tab.id;
                webview(SharedString::from(format!("page-{id}")), &tab.page)
                    .size_full()
                    .on_title_changed(cx.listener(move |this, e: &TitleChanged, _, cx| {
                        if let Some(tab) = this.tab_mut(id) {
                            tab.title = if e.title.is_empty() { "Untitled".into() } else { e.title.clone().into() };
                        }
                        cx.notify();
                    }))
                    .on_navigate(cx.listener(|_, _: &Navigate, _, cx| cx.notify()))
                    .into_any_element()
            }
            None => div().into_any_element(),
        };
        scaffold()
            .key_context("Browser")
            .sidebar(sidebar().min_w(px(240.)).child(
                source_list("tabs").section("Today", items).selected(self.selected.to_string()).on_select(cx.listener(
                    |this, e: &SourceSelected, _, cx| {
                        if let Ok(id) = e.id.parse() {
                            this.selected = id;
                            cx.notify();
                        }
                    },
                )),
            ))
            .content(content)
    }
}

pub fn app() -> Application {
    Application::new(nd::manifest!())
}

pub fn init(cx: &mut App) {
    let url = std::env::var("LYNK_URL").unwrap_or_else(|_| HOME.into());
    cx.open_window(WindowOptions::main("main").title("Lynk Browser").size(size(px(1200.), px(780.))), move |_window, cx| {
        cx.new(move |_cx| Browser::new(&url))
    });
}
