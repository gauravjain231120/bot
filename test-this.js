function handle() {
  console.log(this ? this.id : 'undefined');
  setTimeout(() => {
    console.log("inner", this ? this.id : 'undefined');
  }, 10);
}
const obj = { id: 'localAmazon' };
handle.call(obj);
