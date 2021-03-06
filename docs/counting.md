So you want to keep track of your page views? Then you might want to use a
counter in Redis.

`redis-metrics` provides a simple counter through the {@link
TimestampedCounter} class. The counter object currently has two main
functionalities:

* Incrementing the counter
* Reporting the count

This is really simple, but we are not trying to re-invent the wheel here, just
make it a bit rounder. Besides basic counting, the {@link TimestampedCounter}
offers a bit more functionality... some extra sugar if you will. Let's take a
look.

#### Creating a counter

Usually, a counter is created with the {@link RedisMetrics#counter} function.
Let's start by creating a counter that is capable of reporting counts with a
time granularity of one hour:

```javascript
var metrics = require('redis-metrics')();
var myCounter = metrics.counter('pageview', {
  timeGranularity: 'hour',
  expireKeys: true
};
```

Here, we are passing an options object explicitly to the counter. This is
useful when we want different settings for different counters. We can also
specify some default counter settings on the metrics module itself:

```javascript
var metrics = require('redis-metrics')({
  counterOptions: {
    timeGranularity: 'hour',
    expireKeys: true
  }
});

// Will use the counterOptions object because no options are provided.
var myCounter = metrics.counter('pageview');
```

#### Incrementing a counter

The counter can be incremented in two ways, using {@link
TimestampedCounter#incr|incr} or {@link TimestampedCounter#incrby|incrby}:

```javascript
// Increment by 1
myCounter.incr(function(err, result) {
  console.log(result);
});

// Increment by 5
myCounter.incrby(5, function(err, result) {
  console.log(result);
});
```

The `err` and `result` parameters contain the answer from Redis.

This looks and feels as if we are incrementing a normal Redis counter. Behind
the scenes, that is exactly what is happening but with a slight twist. Since we
have chosen a time granularity of an hour, more than one counter is being
incremented for various timestamps. This does give some extra overhead, but it
makes it very easy and fast to retrieve a count for a specific period.

#### Fetching a count

Since our counter has a time granularity of an hour, we can now answer
questions such as: "How many page views do I have so far today?" and "How many
page views do I have so far this hour?":

```javascript
// Number of page views today.
myCounter.count('day', function(err, result) {
  console.log(result);
});

// Number of page views this hour.
myCounter.count('hour', function(err, result) {
  console.log(result);
});
```

Of course, we can also get the total number of page views:

```javascript
// Number of page views in total.
myCounter.count(function(err, result) {
  console.log(result);
});
```

In all of the above methods `result` is single integer.

#### Fetching a count for a time range

Fetching a single count for the current time is useful, but often it makes
sense to view metrics over a period of time. Let's ask the counter "What is my
page view count for the last 24 hours until now?" using the {@link
TimestampedCounter#countRange|countRange} function:

```javascript
// Moment is nice and easy for dates so we'll just use that here.
var moment = require('moment');
var yesterday = moment().subtract(24, 'hours');

// No end time specified so use the current time will be used.
myCounter.countRange('hour', yesterday, function(err, result) {
  console.log(result);
});

// Use explicit end time.
var now = moment();
myCounter.countRange('hour', yesterday, now, function(err, result) {
  console.log(result);
});
```

The start and end parameters can be anything that that the
[`moment(...)`](http://momentjs.com/docs/#/parsing/) constructor understands.

When requesting a time range, `result` is an object with ISO-formatted
timestamps as keys and the count for each timestamp as the values. For the
above query, `result` could thus be:

```json
{
  '2015-04-15T11:00:00+00:00': 788,
  '2015-04-15T12:00:00+00:00': 237,
  ...
  '2015-04-16T10:00:00+00:00': 519,
  '2015-04-16T11:00:00+00:00': 231
}
```

**Warning**: The timestamps are *always* UTC.

### Using an event object

For many use cases, it makes sense to track an event in a more specific
context. For example, you might want to track the individual page views of
specific pages in your app such as "/about" and "/contact". You could create
separate counters for each of these pages, but for this specific use case, you
might want to use "event objects".

Using the feature is easy and best shown by example. We can use the same page
view counter from before:

```javascript
// Increment the page view counter for the event object "/contact".
myCounter.incr('/contact', function(err, result) {
  console.log(result);
});

// Increment the page view counter for the event object "/about".
myCounter.incr('/about', function(err, result) {
  console.log(result);
});
```

When using an event object, internally in Redis the event objects are
incremented in a sorted set on the given key. After calling the two operations
above, we will thus have a Redis key called "pageview" which contains a [sorted
set](http://redis.io/topics/data-types) with "/about" and "/contact".
Reporting a count for an event object is similar to before:

```javascript
// Number of page views today for about page
myCounter.count('day', '/about', function(err, result) {
  console.log(result);
});

// Number of page views this hour for the contact page
myCounter.count('hour', '/contact', function(err, result) {
  console.log(result);
});
```

Time ranges work as well for event objects. For example, I have this question
"Show me the page view count for the last 24 hours for the /about page" and
here is the answer:

```javascript
// Moment is nice and easy for dates so we'll just use that here.
var moment = require('moment');
var yesterday = moment().subtract(24, 'hours');
var now = moment();

myCounter.countRange('hour', yesterday, now, '/about', function(err, result) {
  console.log(result);
});
```

The output of the above query is similar to before:

```json
{
  '2015-04-15T11:00:00+00:00': 12,
  '2015-04-15T12:00:00+00:00': 67,
  ...
  '2015-04-16T10:00:00+00:00': 93,
  '2015-04-16T11:00:00+00:00': 32
}
```

**Warning**: When using {@link TimestampedCounter#countRange|countRange} for
event objects, the end date is mandatory.

#### Top N for event objects

Because event objects are stored in [sorted
sets](http://redis.io/topics/data-types#sorted-sets), we automatically get some
benefits from Redis. For example, it is very easy to get a list of the top 10
visited pages for our counter or even a sorted list of all pages by page count.

Since we are at a very early stage in the project, this feature has not been
added yet, but it will in the near future because it fits our own use cases
very well. Stay tuned :-)
