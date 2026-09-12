export function TaskBoardSkeleton() {
  return (
    <div className="board skeleton-board" aria-label="Loading tasks" aria-busy="true">
      {Array.from({ length: 5 }, (_, column) => (
        <section className="board-column" key={column}>
          <div className="skeleton skeleton-heading" />
          <div className="skeleton skeleton-card" />
          {column < 2 && <div className="skeleton skeleton-card short" />}
        </section>
      ))}
    </div>
  );
}
