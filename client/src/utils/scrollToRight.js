// Mobile: slides the layout over to the content pane (from the sidebar).
export function scrollToRight() {
  const wrapper = document.querySelector('.main-wrapper');
  if (wrapper) {
    requestAnimationFrame(() => {
      wrapper.scrollBy({ left: window.innerWidth, behavior: 'smooth' });
    });
  }
}
