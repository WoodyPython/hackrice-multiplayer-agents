-- Applying a review now waits for the owner's final confirmation.
alter type task_status add value if not exists 'awaiting_confirmation' after 'ready_for_review';
