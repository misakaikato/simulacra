CREATE TABLE user (
	user_id INTEGER PRIMARY KEY,
	agent_id INTEGER,
	user_name TEXT,
	name TEXT,
	bio TEXT,
	created_at DATETIME,
	num_followings INTEGER DEFAULT 0,
	num_followers INTEGER DEFAULT 0
);
CREATE TABLE post (
	post_id INTEGER PRIMARY KEY,
	user_id INTEGER,
	original_post_id INTEGER,
	content TEXT,
	quote_content TEXT,
	created_at DATETIME,
	num_likes INTEGER DEFAULT 0,
	num_dislikes INTEGER DEFAULT 0,
	num_shares INTEGER DEFAULT 0,
	num_reports INTEGER DEFAULT 0
);
CREATE TABLE trace (
	user_id INTEGER,
	created_at DATETIME,
	action TEXT,
	info TEXT
);
CREATE TABLE "like" (
	like_id INTEGER PRIMARY KEY,
	post_id INTEGER,
	user_id INTEGER,
	created_at DATETIME
);
CREATE TABLE follow (
	follow_id INTEGER PRIMARY KEY,
	follower_id INTEGER,
	followee_id INTEGER,
	created_at DATETIME
);
INSERT INTO user VALUES
	(1, 0, 'ada', 'Ada', 'Likes numbers', '0', 1, 0),
	(2, 1, 'ben', 'Ben', 'Likes birds', '0', 0, 0),
	(3, 2, 'cleo', 'Cleo', 'Likes cats', '0', 0, 1);
INSERT INTO post VALUES
	(1, 1, NULL, 'hello world', NULL, '1', 1, 0, 1, 0),
	(2, 2, NULL, 'birds are great', NULL, '1', 0, 0, 0, 0),
	(3, 3, NULL, 'cats are better', NULL, '2', 0, 0, 0, 0),
	(4, 1, NULL, 'numbers never lie', NULL, '3', 0, 0, 0, 0),
	(5, 2, 1, 'hello world', NULL, '3', 0, 0, 0, 0);
INSERT INTO trace VALUES
	(1, '1', 'REFRESH', '{"posts": []}'),
	(1, '1', 'CREATE_POST', '{"content": "hello world", "post_id": 1}'),
	(2, '1', 'CREATE_POST', '{"content": "birds are great", "post_id": 2}'),
	(2, '2', 'REFRESH', '{"posts": [{"post_id": 1, "content": "hello world"}]}'),
	(3, '2', 'CREATE_POST', '{"content": "cats are better", "post_id": 3}'),
	(2, '2', 'LIKE_POST', '{"post_id": 1, "like_id": 1}'),
	(3, '3', 'REFRESH', '{"posts": [{"post_id": 2, "content": "birds are great"}]}'),
	(1, '3', 'CREATE_POST', '{"content": "numbers never lie", "post_id": 4}'),
	(1, '3', 'FOLLOW', '{"followee_id": 3, "follow_id": 1}'),
	(1, '4', 'REFRESH', '{"posts": [{"post_id": 3, "content": "cats are better"}]}');
INSERT INTO "like" VALUES (1, 1, 2, '2');
INSERT INTO follow VALUES (1, 1, 3, '3');
