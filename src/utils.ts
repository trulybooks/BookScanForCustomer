/**
 * Simple UI utility functions
 */
export class UIUtils {
	/**
	 * Show a toast notification
	 */
	static showToast(message: string, duration: number = 3000): void {
		const toast = document.getElementById('toast');
		if (!toast) return;

		toast.textContent = message;
		toast.classList.add('active');

		setTimeout(() => {
			toast.classList.remove('active');
		}, duration);
	}

	/**
	 * Show a modal
	 */
	static showModal(modalId: string): void {
		document.getElementById(modalId)?.classList.add('active');
	}

	/**
	 * Hide a modal and clear whatever was typed into it
	 */
	static hideModal(modalId: string): void {
		const modal = document.getElementById(modalId);
		if (!modal) return;

		modal.classList.remove('active');
		modal.querySelectorAll('input').forEach(input => {
			input.value = '';
		});
	}
}
