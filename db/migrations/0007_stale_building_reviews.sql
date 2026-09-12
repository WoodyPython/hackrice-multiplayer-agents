-- A human edit can invalidate a review before its candidate has been built.
-- Ready/conflict/applied reviews must still always identify a candidate.
alter table reviews drop constraint reviews_candidate_ck;
alter table reviews add constraint reviews_candidate_ck
  check (status in ('building', 'stale') or candidate_sha is not null);
