-- 069 任务卡的“可以用什么”：老板写的工具、账号、资料、参考实现。派工正文的第二段与 task.md 的“可以用”一节都取这里。
-- 只新增一个可空字段，不改写既有行；旧任务没有这个字段，派工正文只列每条线都有的笔记与工作能力目录。
DEFINE FIELD IF NOT EXISTS resources ON task TYPE option<string>;
